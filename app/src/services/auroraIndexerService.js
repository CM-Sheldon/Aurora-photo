const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ExifTool } = require('exiftool-vendored');
const sharp = require('sharp');
const db = require('./auroraDbService');

// ── Memory safety: this box may have very little RAM (2GB) ──
// Disable libvips operation cache (it holds decoded images) and pin to one
// thread per op so concurrent thumbnails don't multiply memory.
sharp.cache(false);
sharp.concurrency(1);

const THUMB_DIR = process.env.AURORA_THUMB_DIR || path.join(__dirname, '../../cache/aurora/thumbs');
try { fs.mkdirSync(THUMB_DIR, { recursive: true }); } catch (_) {}
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tiff', '.tif', '.webp', '.gif', '.bmp', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf', '.rw2', '.dng']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.mts', '.m2ts', '.wmv', '.3gp', '.flv', '.webm']);

// Concurrency tuned for a 2GB / 4-CPU box. Metadata indexing is light and
// largely I/O-bound (reads over NFS), so some overlap helps throughput while
// memory stays flat (~300MB measured). Override via env if needed.
const INDEX_CONCURRENCY = parseInt(process.env.AURORA_INDEX_CONCURRENCY) || 8;
// Total concurrent thumbnail generations (shared by on-demand + background warmer).
const THUMB_CONCURRENCY = parseInt(process.env.AURORA_THUMB_CONCURRENCY) || 6;
// The warmer uses only some of those slots, so interactive on-demand requests
// (the region you're actually looking at) always have headroom and stay snappy.
const WARM_CONCURRENCY = parseInt(process.env.AURORA_WARM_CONCURRENCY) || 3;

// exiftool worker processes (each ~30-50MB). Shared across index workers.
const exiftool = new ExifTool({ taskTimeoutMillis: 15000, maxProcs: 4 });

// Active import sessions (in-memory; the DB row is the durable record)
const activeSessions = new Map();

// ── Tiny semaphore for bounded concurrency ──
class Semaphore {
  constructor(n) { this.n = n; this.queue = []; }
  acquire() {
    return this.n > 0
      ? (this.n--, Promise.resolve())
      : new Promise(r => this.queue.push(r));
  }
  release() {
    if (this.queue.length) this.queue.shift()();
    else this.n++;
  }
}
const thumbSem = new Semaphore(THUMB_CONCURRENCY);

function pushLog(session, msg) {
  session.log.push(msg);
  if (session.log.length > 100) session.log.shift(); // cap memory
}

function quickHash(filePath, stat) {
  return crypto.createHash('sha1')
    .update(filePath + Math.floor(stat.mtimeMs) + stat.size)
    .digest('hex');
}

// ── Lean offline reverse geocoder (a few MB in memory, no network) ──
const geocoder = require('./auroraGeocoderService');

async function getOrCreatePlace(lat, lon) {
  if (lat == null || lon == null) return null;
  const rLat = Math.round(lat * 100) / 100;
  const rLon = Math.round(lon * 100) / 100;

  const existing = await db.get(
    'SELECT id FROM places WHERE ABS(lat - ?) < 0.01 AND ABS(lon - ?) < 0.01',
    [rLat, rLon]
  );
  if (existing) return existing.id;

  let name = null, country = null;
  try {
    const r = await geocoder.lookup(lat, lon);
    if (r) { name = r.name; country = r.country; }
  } catch (_) {}

  const row = await db.run(
    'INSERT INTO places (name, country, lat, lon) VALUES (?, ?, ?, ?)',
    [name, country, rLat, rLon]
  );
  if (row.lastID) return row.lastID;
  const found = await db.get(
    'SELECT id FROM places WHERE ABS(lat - ?) < 0.01 AND ABS(lon - ?) < 0.01',
    [rLat, rLon]
  );
  return found ? found.id : null;
}

function videoMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.wmv': 'video/x-ms-wmv', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t', '.3gp': 'video/3gpp' };
  return map[ext] || 'video/mp4';
}

// ── Capture-date extraction ──────────────────────────────────────────────────
// Parse one exiftool date tag (an ExifDateTime object or a string) → epoch ms,
// or null if missing/invalid/bogus.
function parseExifDate(raw) {
  if (raw == null) return null;
  let ms;
  try { ms = (raw && raw.toDate ? raw.toDate() : new Date(raw)).getTime(); }
  catch (_) { return null; }
  if (!Number.isFinite(ms)) return null;
  // Reject the zeroed QuickTime epoch (1904), Unix-epoch placeholders, and
  // absurd future dates that signal a garbage tag.
  const year = new Date(ms).getUTCFullYear();
  if (year < 1990 || ms > Date.now() + 86400000) return null;
  return ms;
}

// Recover a capture date encoded in the filename (common for phone/camera exports
// and screenshots) — used only when no embedded date tag is present.
function dateFromFilename(filePath) {
  const name = path.basename(filePath);
  // YYYYMMDD with optional HHMMSS: IMG_20180502_134501, PXL_20210301_..., VID_20180502
  let m = name.match(/(?:^|[^0-9])(19[89]\d|20[0-3]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[ _-]?([01]\d|2[0-3])([0-5]\d)([0-5]\d))?/);
  if (!m) {
    // YYYY-MM-DD with optional time: "2018-05-02 12.34.56", "2018_05_02"
    m = name.match(/(19[89]\d|20[0-3]\d)[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])(?:[ _T]([01]\d|2[0-3])[._-]([0-5]\d)[._-]([0-5]\d))?/);
  }
  if (!m) return null;
  const [, y, mo, d, hh = '12', mm = '00', ss = '00'] = m;
  const ms = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Best available capture date. Embedded tags first (videos rarely set
// DateTimeOriginal, so QuickTime CreationDate/CreateDate/MediaCreateDate are
// included), then a filename-encoded date. Deliberately NOT FileModifyDate —
// that's the copy/download time, which clusters cloud-exported videos at "now".
function extractTakenAt(tags, filePath) {
  const candidates = [
    tags.SubSecDateTimeOriginal, tags.DateTimeOriginal, tags.CreationDate,
    tags.CreateDate, tags.MediaCreateDate, tags.TrackCreateDate,
  ];
  for (const c of candidates) {
    const ms = parseExifDate(c);
    if (ms != null) return ms;
  }
  return dateFromFilename(filePath);
}

// ── On-demand thumbnail generation (called by the /thumb route, NOT by import) ──
// Globally bounded by thumbSem so a burst of browser requests can't OOM the box.
async function ensureThumb(assetId, filePath, kind, size = 'grid') {
  const out = getThumbPath(assetId, size);
  if (fs.existsSync(out)) return out;

  await thumbSem.acquire();
  try {
    if (fs.existsSync(out)) return out; // another request beat us to it
    if (!fs.existsSync(filePath)) return null;

    if (kind === 'photo') {
      if (size === 'full') {
        // Uncropped, fit inside a 2048px box — for the lightbox (no cropping)
        await sharp(filePath, { limitInputPixels: 300000000, failOn: 'none' })
          .rotate()
          .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 84 })
          .toFile(out);
      } else {
        const px = size === 'preview' ? 800 : size === 'cover' ? 400 : 280;
        await sharp(filePath, { limitInputPixels: 100000000, failOn: 'none' })
          .rotate()
          .resize(px, px, { fit: 'cover', position: 'entropy' })
          .webp({ quality: 80 })
          .toFile(out);
      }
      return fs.existsSync(out) ? out : null;
    }

    if (kind === 'video') {
      const gridOut = getThumbPath(assetId, 'grid'); // videos only get one poster size
      if (fs.existsSync(gridOut)) return gridOut;
      const { execFile } = require('child_process');
      const grab = (seek) => new Promise(resolve => {
        execFile('ffmpeg', [
          '-ss', seek, '-i', filePath,
          '-vframes', '1',
          '-vf', 'scale=280:280:force_original_aspect_ratio=increase,crop=280:280',
          '-f', 'image2', gridOut, '-y'
        ], { timeout: 20000 }, () => resolve());
      });
      await grab('00:00:01');
      // Short clip? Seeking 1s in may yield nothing — retry from the very start.
      if (!fs.existsSync(gridOut)) await grab('00:00:00');
      return fs.existsSync(gridOut) ? gridOut : null;
    }

    return null;
  } catch (_) {
    return null;
  } finally {
    thumbSem.release();
  }
}

// ── Metadata indexing (light, no image decoding) ──
async function indexFile(filePath, opts = {}) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return 'skip'; }

  const mtime = Math.floor(stat.mtimeMs);
  const ext = path.extname(filePath).toLowerCase();
  const kind = PHOTO_EXTS.has(ext) ? 'photo' : VIDEO_EXTS.has(ext) ? 'video' : null;
  if (!kind) return 'skip';

  // Resumable: skip files already indexed at this mtime. `force` re-reads
  // metadata even when unchanged (used by the "Re-index metadata" action so
  // improved extraction is applied to an existing library).
  const existing = await db.get('SELECT id, mtime FROM assets WHERE path = ?', [filePath]);
  if (existing && existing.mtime === mtime && !opts.force) return 'skip';

  let takenAt = null, lat = null, lon = null, camera = null, lens = null;
  let width = null, height = null, durationS = null;

  try {
    const tags = await exiftool.read(filePath);
    takenAt = extractTakenAt(tags, filePath);
    lat = typeof tags.GPSLatitude === 'number' ? tags.GPSLatitude : null;
    lon = typeof tags.GPSLongitude === 'number' ? tags.GPSLongitude : null;
    camera = [tags.Make || '', tags.Model || ''].filter(Boolean).join(' ').trim() || null;
    lens = tags.LensModel || tags.Lens || null;
    width = tags.ImageWidth || tags.ExifImageWidth || null;
    height = tags.ImageHeight || tags.ExifImageHeight || null;
    durationS = tags.Duration ? parseFloat(tags.Duration) : null;
    if (isNaN(durationS)) durationS = null;
  } catch (_) {
    // Unreadable EXIF — still index with filesystem metadata
  }

  const placeId = await getOrCreatePlace(lat, lon);
  const hash = quickHash(filePath, stat);

  if (existing) {
    await db.run(
      `UPDATE assets SET content_hash=?, kind=?, bytes=?, width=?, height=?, duration_s=?,
       taken_at=?, gps_lat=?, gps_lon=?, place_id=?, camera=?, lens=?, mtime=?, indexed_at=?
       WHERE id=?`,
      [hash, kind, stat.size, width, height, durationS, takenAt, lat, lon, placeId,
       camera, lens, mtime, Date.now(), existing.id]
    );
  } else {
    await db.run(
      `INSERT INTO assets (path, content_hash, kind, bytes, width, height, duration_s,
       taken_at, gps_lat, gps_lon, place_id, camera, lens, mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [filePath, hash, kind, stat.size, width, height, durationS, takenAt, lat, lon,
       placeId, camera, lens, mtime, Date.now()]
    );
  }

  // NOTE: thumbnails are NOT generated here — they're made on demand by the
  // /thumb route as the browser requests them. This keeps import memory flat.
  return 'indexed';
}

// ── Async directory walk that yields to the event loop so the progress
//    endpoint stays responsive while scanning 100K+ files ──
async function walkDir(dir, files, counter) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, files, counter);
    } else if (entry.isFile()) {
      files.push(full);
      if (++counter.n % 2000 === 0) await new Promise(r => setImmediate(r));
    }
  }
}

async function processBatch(files, session, concurrency, opts = {}) {
  let idx = 0;
  async function worker() {
    while (idx < files.length) {
      const file = files[idx++];
      try {
        const result = await indexFile(file, opts);
        if (result === 'indexed') session.indexed++;
        else session.skipped++;
      } catch (err) {
        session.errors++;
        pushLog(session, `Error: ${path.basename(file)} — ${err.message}`);
      }
      const done = session.indexed + session.skipped + session.errors;
      if (done % 500 === 0) {
        const pct = Math.round((done / session.scanned) * 100);
        pushLog(session, `${done.toLocaleString()} / ${session.scanned.toLocaleString()} (${pct}%)`);
        // Durable checkpoint so a crash doesn't lose all progress
        await db.run(
          'UPDATE import_sessions SET scanned=?, indexed=?, skipped=?, errors=? WHERE id=?',
          [session.scanned, session.indexed, session.skipped, session.errors, session.id]
        ).catch(() => {});
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function startImport(sourcePath, sessionId, opts = {}) {
  // Prune finished in-memory sessions so the Map doesn't grow unbounded
  for (const [id, s] of activeSessions) {
    if ((s.status === 'complete' || s.status === 'error') && Date.now() - (s.startedAt || 0) > 3600000) {
      activeSessions.delete(id);
    }
  }

  const session = {
    id: sessionId, sourcePath, status: 'scanning',
    scanned: 0, indexed: 0, skipped: 0, errors: 0,
    log: [], startedAt: Date.now()
  };
  activeSessions.set(sessionId, session);

  await db.run(
    'INSERT INTO import_sessions (id, source_path, started_at, status) VALUES (?, ?, ?, ?)',
    [sessionId, sourcePath, session.startedAt, 'running']
  );

  // Run async — does not block the HTTP response
  (async () => {
    try {
      pushLog(session, `Scanning ${sourcePath}…`);
      const files = [];
      await walkDir(sourcePath, files, { n: 0 });
      session.scanned = files.length;
      session.status = 'indexing';
      pushLog(session, `Found ${files.length.toLocaleString()} files. Indexing with ${INDEX_CONCURRENCY} workers…`);
      await db.run('UPDATE import_sessions SET scanned=? WHERE id=?', [session.scanned, sessionId]).catch(() => {});

      await processBatch(files, session, INDEX_CONCURRENCY, { force: !!opts.force });

      // Pair Live Photos (still + short clip) so they show as one item.
      pushLog(session, 'Linking Live Photos…');
      try {
        const { linked } = await linkLivePhotos();
        pushLog(session, `Linked ${linked.toLocaleString()} Live Photos.`);
      } catch (_) {}

      session.status = 'complete';
      pushLog(session, `Complete — ${session.indexed.toLocaleString()} indexed, ${session.skipped.toLocaleString()} skipped, ${session.errors} errors. Warming thumbnails in the background…`);
      await db.run(
        'UPDATE import_sessions SET finished_at=?, status=?, scanned=?, indexed=?, skipped=?, errors=? WHERE id=?',
        [Date.now(), 'complete', session.scanned, session.indexed, session.skipped, session.errors, sessionId]
      ).catch(() => {});

      // Kick off background thumbnail warming so browsing is instant
      // (AURORA_NO_AUTOWARM lets tests/ops isolate the indexing phase)
      if (process.env.AURORA_NO_AUTOWARM !== '1') startThumbnailWarming();
    } catch (err) {
      session.status = 'error';
      pushLog(session, `Fatal: ${err.message}`);
      await db.run('UPDATE import_sessions SET status=? WHERE id=?', ['error', sessionId]).catch(() => {});
    }
  })();

  return session;
}

// ── Background thumbnail warmer ──────────────────────────────────────────────
// On-demand generation can't keep up when you browse a fresh region (each photo
// is a sharp resize, each video an ffmpeg poster). This pre-generates the grid
// thumbnails for the whole library in the background, bounded by thumbSem so it
// never spikes memory. Resumable: already-cached thumbs are skipped instantly.
const warmState = { running: false, done: 0, total: 0, generated: 0, phase: 'idle' };

async function warmBatch(rows) {
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const r = rows[i++];
      const out = getThumbPath(r.id, 'grid');
      if (!fs.existsSync(out)) {
        const made = await ensureThumb(r.id, r.path, r.kind, 'grid');
        if (made) warmState.generated++;
      }
      warmState.done++;
    }
  }
  // Fewer workers than the semaphore, so on-demand requests keep free slots
  await Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker));
}

async function startThumbnailWarming() {
  if (warmState.running) return warmState;
  warmState.running = true;
  warmState.done = 0;
  warmState.generated = 0;

  (async () => {
    try {
      const totalRow = await db.get('SELECT COUNT(*) c FROM assets');
      warmState.total = totalRow ? totalRow.c : 0;

      // Photos first (fast, the bulk of the library), then videos (ffmpeg, slower)
      for (const kind of ['photo', 'video']) {
        warmState.phase = kind === 'photo' ? 'photos' : 'videos';
        const PAGE = 500;
        let offset = 0;
        while (true) {
          const rows = await db.all(
            'SELECT id, path, kind FROM assets WHERE kind = ? ORDER BY taken_at DESC LIMIT ? OFFSET ?',
            [kind, PAGE, offset]
          );
          if (!rows.length) break;
          await warmBatch(rows);
          offset += PAGE;
        }
      }
      warmState.phase = 'complete';
    } catch (_) {
      warmState.phase = 'error';
    } finally {
      warmState.running = false;
      // Post-warm hook, retained as a seam for downstream tasks (e.g. auto-
      // starting a background job that reads cached thumbnails). No-op unless
      // server.js wires it up. Fires only on a clean completion.
      if (warmState.phase === 'complete' && onWarmingComplete) {
        try { onWarmingComplete(); } catch (_) {}
      }
    }
  })();

  return warmState;
}

function getWarmState() { return warmState; }

// ── Live Photo pairing ───────────────────────────────────────────────────────
// An iPhone Live Photo is a still plus a short companion clip sharing the same
// path-minus-extension (e.g. IMG_9055.HEIC + IMG_9055.MOV). We link the still to
// its clip (assets.live_video_id) and flag the clip (is_live_motion=1) so it's
// hidden from the main grid/timeline. Pure path + capture-time matching — no
// file access — so it safely backfills an existing library and is idempotent.
//
// Two independent name-matches can produce the WRONG pair: iOS recycles its
// IMG_NNNN counter over multi-year timelines, so IMG_1190.jpg from 2019 and
// IMG_1190.MOV from 2021 can land in the same folder without being a real Live
// Photo pair. A real pair is captured within milliseconds; anything more than
// LIVE_MAX_TIME_GAP_MS apart is a filename collision. Both sides must therefore
// have a known taken_at (iOS files always do) and their gap must be within the
// window. If either side has NULL taken_at we refuse to pair — that's the safe
// call because on this library ~26% of assets are timestamp-less (scans,
// exported without EXIF, etc.) and none of those are Live Photos.
//
// Note: a single base name can have multiple photo variants (e.g. IMG_0015.JPG
// and IMG_0015.PNG exported by iOS). We link ALL variants whose taken_at also
// matches the clip so none appear as an orphan without the Live badge.
const LIVE_MAX_DURATION_S = 6;
const LIVE_MAX_TIME_GAP_MS = 5000;

async function linkLivePhotos() {
  const stripExt = (p) => p.replace(/\.[^./]+$/, '').toLowerCase();

  const photos = await db.all(`SELECT id, path, taken_at FROM assets WHERE kind='photo'`);
  // Map base path → array of photos (multiple extensions can share a base).
  const photosByBase = new Map();
  for (const p of photos) {
    const base = stripExt(p.path);
    if (!photosByBase.has(base)) photosByBase.set(base, []);
    photosByBase.get(base).push(p);
  }

  const videos = await db.all(`SELECT id, path, duration_s, taken_at FROM assets WHERE kind='video'`);

  let linked = 0, cleared = 0, rejectedByTime = 0;
  await db.run('BEGIN').catch(() => {});
  try {
    // Rebuild from scratch. Any prior pairing (correct or not) is wiped so the
    // new algorithm's answer wins deterministically. Without this the button
    // felt like it "did nothing" — it re-set correct pairs but couldn't undo
    // stale wrong ones. cleared counts what changed so the UI can prove it.
    const prev = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM assets WHERE live_video_id IS NOT NULL)    AS photos_linked,
         (SELECT COUNT(*) FROM assets WHERE is_live_motion = 1)           AS videos_flagged`
    );
    await db.run('UPDATE assets SET live_video_id = NULL WHERE live_video_id IS NOT NULL');
    await db.run('UPDATE assets SET is_live_motion = 0 WHERE is_live_motion = 1');

    for (const v of videos) {
      // Live clips are always short; never hide a full-length namesake video.
      if (v.duration_s != null && v.duration_s > LIVE_MAX_DURATION_S) continue;
      const candidates = photosByBase.get(stripExt(v.path));
      if (!candidates || !candidates.length) continue;

      // Timestamp gate: keep only photos whose taken_at is within the window of
      // the video's taken_at. Missing timestamps → skip; iOS Live Photos always
      // have both, so this only excludes accidental basename collisions.
      const matches = [];
      for (const p of candidates) {
        if (p.taken_at == null || v.taken_at == null) { rejectedByTime++; continue; }
        if (Math.abs(p.taken_at - v.taken_at) > LIVE_MAX_TIME_GAP_MS) { rejectedByTime++; continue; }
        matches.push(p);
      }
      if (!matches.length) continue;

      for (const p of matches) {
        await db.run('UPDATE assets SET live_video_id = ? WHERE id = ?', [v.id, p.id]);
        linked++;
      }
      await db.run('UPDATE assets SET is_live_motion = 1 WHERE id = ?', [v.id]);
    }
    // Net change from the previous state — surfaced to the UI so the user can
    // see the button actually did something even when the total link count
    // hasn't moved.
    cleared = Math.max(0, (prev && prev.photos_linked || 0) - linked);
    await db.run('COMMIT').catch(() => {});
  } catch (err) {
    await db.run('ROLLBACK').catch(() => {});
    throw err;
  }
  return { linked, cleared, rejectedByTime };
}

// Called on server startup: any session still marked 'running' was killed
// mid-scan by a crash/restart. Mark it interrupted so the UI/DB is consistent.
async function recoverInterruptedSessions() {
  try {
    await db.run("UPDATE import_sessions SET status='interrupted' WHERE status='running'");
  } catch (_) {}
}

function getSession(sessionId) {
  return activeSessions.get(sessionId) || null;
}

// True while any import is actively scanning/indexing. Background workers (e.g.
// the caption service) check this so heavy work pauses during an import — avoids
// memory contention on the 2GB box. Completed/errored sessions linger in the Map
// but don't count.
function isIndexing() {
  for (const s of activeSessions.values()) {
    if (s.status === 'scanning' || s.status === 'indexing') return true;
  }
  return false;
}

// Hook fired once thumbnail warming finishes. Seam retained for future use — no
// current caller (was previously used to auto-start the removed COCO-SSD tagger).
let onWarmingComplete = null;
function setWarmingCompleteHook(fn) { onWarmingComplete = fn; }

function getThumbPath(assetId, size = 'grid') {
  return path.join(THUMB_DIR, `${assetId}_${size}.webp`);
}

async function shutdown() {
  try { await exiftool.end(); } catch (_) {}
}

module.exports = {
  startImport, getSession, getThumbPath, ensureThumb,
  recoverInterruptedSessions, videoMimeType, shutdown,
  startThumbnailWarming, getWarmState, linkLivePhotos,
  isIndexing, setWarmingCompleteHook,
  // Exported for unit tests
  extractTakenAt, parseExifDate, dateFromFilename,
  THUMB_DIR, INDEX_CONCURRENCY, THUMB_CONCURRENCY
};
