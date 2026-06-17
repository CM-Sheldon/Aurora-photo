const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const os = require('os');
const db = require('../services/auroraDbService');
const { startImport, getSession, getThumbPath, ensureThumb, videoMimeType,
        startThumbnailWarming, getWarmState, linkLivePhotos, THUMB_DIR } = require('../services/auroraIndexerService');
const { mountShare, unmountShare, isMounted, listActiveMounts, MOUNT_BASE } = require('../services/shareMountService');
const geocoder = require('../services/auroraGeocoderService');

// RAW stills can't be decoded for preview, so the UI offers a "hide RAW" toggle.
// These are the RAW extensions the indexer treats as photos (see PHOTO_EXTS).
const RAW_EXTS = ['raw', 'arw', 'cr2', 'cr3', 'nef', 'orf', 'rw2', 'dng'];
function rawExclusion(col) {
  return {
    sql: '(' + RAW_EXTS.map(() => `LOWER(${col}) NOT LIKE ?`).join(' AND ') + ')',
    params: RAW_EXTS.map(e => '%.' + e),
  };
}

// ── Free-text search ─────────────────────────────────────────────────────────
// Tokenised, auto-wildcard, fuzzy-tolerant search powering the Search screen and
// the `q` param of /assets. Each whitespace token is wrapped in %…% (so partial
// words match — "beac" finds "beach") and tested against filename, camera, lens,
// place name, country and capture year, plus a set of smart keywords. Tokens are
// ANDed so a query narrows progressively ("canon paris 2019"); if the strict AND
// finds nothing the route retries with OR, which absorbs typos and extra words.
const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

// SQL fragment + params matching one token across every searchable field.
function tokenClause(token) {
  const t = token.toLowerCase();
  const like = '%' + t.replace(/[%_\\]/g, m => '\\' + m) + '%';
  const ors = [];
  const params = [];
  const text = (expr) => { ors.push(`LOWER(${expr}) LIKE ? ESCAPE '\\'`); params.push(like); };

  text('a.path');                 // filename / folder
  text('a.camera');
  text('a.lens');
  text('p.name');                 // place
  text('p.country');
  ors.push(`CAST(strftime('%Y', datetime(a.taken_at/1000,'unixepoch')) AS TEXT) LIKE ? ESCAPE '\\'`);
  params.push(like);              // capture year, e.g. "2019"
  // user tags — makes "cyprus holiday" find everything tagged that way
  ors.push(`EXISTS (SELECT 1 FROM asset_tags att JOIN tags tt ON tt.id = att.tag_id WHERE att.asset_id = a.id AND LOWER(tt.name) LIKE ? ESCAPE '\\')`);
  params.push(like);

  // Smart keywords — let people type what they mean.
  if (/^(photo|photos|image|images|pic|pics|picture|pictures|still|stills)$/.test(t)) ors.push(`a.kind = 'photo'`);
  if (/^(video|videos|movie|movies|clip|clips)$/.test(t)) ors.push(`a.kind = 'video'`);
  if (/^(fav|favs|favourite|favourites|favorite|favorites|starred|loved|hearted)$/.test(t)) ors.push(`a.fav = 1`);
  if (/^(live|livephoto|livephotos|motion)$/.test(t)) ors.push(`a.live_video_id IS NOT NULL`);
  if (/^raws?$/.test(t)) { const r = rawExclusion('a.path'); ors.push('NOT ' + r.sql); params.push(...r.params); }
  if (MONTHS[t]) { ors.push(`strftime('%m', datetime(a.taken_at/1000,'unixepoch')) = ?`); params.push(MONTHS[t]); }

  return { sql: '(' + ors.join(' OR ') + ')', params };
}

// Combine all tokens with AND (narrowing) or OR (fuzzy fallback).
function buildSearch(q, mode = 'and') {
  const tokens = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!tokens.length) return { sql: '', params: [], tokens: 0 };
  const parts = tokens.map(tokenClause);
  const joiner = mode === 'or' ? ' OR ' : ' AND ';
  return {
    sql: '(' + parts.map(p => p.sql).join(joiner) + ')',
    params: parts.flatMap(p => p.params),
    tokens: tokens.length,
  };
}

// Vocabulary of real words in the library (place / country / camera words), used
// to spell-correct typo'd search tokens. Cached briefly so it isn't rebuilt on
// every keystroke.
let vocabCache = { words: [], ts: 0 };
async function getVocab() {
  if (vocabCache.words.length && Date.now() - vocabCache.ts < 60000) return vocabCache.words;
  const words = new Set();
  const add = (s) => { for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) words.add(w); };
  try {
    for (const p of await db.all(`SELECT DISTINCT name, country FROM places`)) { add(p.name); add(p.country); }
    for (const c of await db.all(`SELECT DISTINCT camera FROM assets WHERE camera IS NOT NULL`)) add(c.camera);
    for (const t of await db.all(`SELECT name FROM tags`)) add(t.name);
  } catch (_) {}
  vocabCache = { words: [...words], ts: Date.now() };
  return vocabCache.words;
}

// Levenshtein distance, bailing out early once it can't be small.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

// Return a spelling-corrected version of `q`, or null if nothing needed fixing.
// Only corrects word-ish tokens that aren't already a substring of a real word
// and that have a near (≈1 typo / 4 chars) match in the vocabulary.
async function fuzzyCorrectQuery(q) {
  const tokens = String(q).trim().split(/\s+/).filter(Boolean);
  const vocab = await getVocab();
  if (!vocab.length) return null;
  let changed = false;
  const out = tokens.map(tok => {
    const t = tok.toLowerCase();
    if (t.length < 4 || /^\d+$/.test(t) || MONTHS[t]) return tok;
    if (vocab.some(w => w.includes(t))) return tok;   // already a valid partial
    let best = null, bestD = Infinity;
    const max = Math.max(1, Math.floor(t.length / 4));
    for (const w of vocab) {
      const d = editDistance(t, w);
      if (d < bestD) { bestD = d; best = w; if (d === 1) break; }
    }
    if (best && bestD <= max) { changed = true; return best; }
    return tok;
  });
  return changed ? out.join(' ') : null;
}

// GET /api/aurora/assets?from&to&place&person&kind&fav&q&hideRaw&limit&offset&count
// `place` accepts a single id or a comma-separated list (used by map clusters).
// `q` is free-text search (see buildSearch). `count=1` also returns the total
// number of matches (the Search screen uses it to show an accurate result count).
router.get('/assets', async (req, res) => {
  try {
    const { from, to, place, person, kind, fav, q, hideRaw, count, camera, country, tag } = req.query;
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit) || 200));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    // Filters common to both the AND and OR (fuzzy) passes.
    const base = [];
    const baseParams = [];
    if (from) { base.push('a.taken_at >= ?'); baseParams.push(parseInt(from)); }
    if (to) { base.push('a.taken_at <= ?'); baseParams.push(parseInt(to)); }
    if (place) {
      const ids = String(place).split(',').map(s => parseInt(s, 10)).filter(Number.isFinite);
      if (ids.length === 1) { base.push('a.place_id = ?'); baseParams.push(ids[0]); }
      else if (ids.length > 1) { base.push(`a.place_id IN (${ids.map(() => '?').join(',')})`); baseParams.push(...ids); }
    }
    if (kind) { base.push('a.kind = ?'); baseParams.push(kind); }
    if (camera) { base.push('a.camera = ?'); baseParams.push(camera); }
    if (country) { base.push('p.country = ?'); baseParams.push(country); }
    if (tag) { base.push('EXISTS (SELECT 1 FROM asset_tags atf WHERE atf.asset_id = a.id AND atf.tag_id = ?)'); baseParams.push(parseInt(tag)); }
    if (fav === '1') { base.push('a.fav = 1'); }
    if (hideRaw === '1') { const r = rawExclusion('a.path'); base.push(r.sql); baseParams.push(...r.params); }
    // Live Photo motion clips are surfaced via their still, never as standalone items
    base.push('a.is_live_motion = 0');
    // Privacy / duplicates — showHidden=1 flips to the hidden album view
    if (req.query.showHidden === '1') {
      base.push('a.hidden = 1');
    } else {
      base.push('a.hidden = 0');
      base.push('a.duplicate_of IS NULL');
    }

    const FROM = `FROM assets a LEFT JOIN places p ON a.place_id = p.id`;
    const countMatches = async (clauses, params) =>
      (await db.get(`SELECT COUNT(*) AS c ${FROM} WHERE ${clauses.join(' AND ')}`, params)).c;

    // Pick the best clause for a query string: strict AND first, then OR if AND
    // matched nothing and there are multiple tokens (so a stray word still hits).
    async function chooseClause(queryStr) {
      const and = buildSearch(queryStr, 'and');
      if (!and.sql) return { sql: '', params: [], fuzzy: false };
      if (and.tokens > 1 && await countMatches([...base, and.sql], [...baseParams, ...and.params]) === 0) {
        const or = buildSearch(queryStr, 'or');
        return { sql: or.sql, params: or.params, fuzzy: true };
      }
      return { sql: and.sql, params: and.params, fuzzy: false };
    }

    let searchSql = '', searchParams = [], fuzzy = false, corrected = null, matchCount = null;
    const rawQ = q && String(q).trim() ? String(q).trim() : '';
    if (rawQ) {
      let c = await chooseClause(rawQ);
      matchCount = await countMatches([...base, c.sql], [...baseParams, ...c.params]);
      // Still nothing? Try spelling-correcting the query against the library's
      // own vocabulary (place/country/camera words) — fixes single-word typos
      // like "bournmouth" that wildcards alone can't catch.
      if (matchCount === 0) {
        const fixed = await fuzzyCorrectQuery(rawQ);
        if (fixed && fixed.toLowerCase() !== rawQ.toLowerCase()) {
          const c2 = await chooseClause(fixed);
          const m2 = await countMatches([...base, c2.sql], [...baseParams, ...c2.params]);
          if (m2 > 0) { c = c2; matchCount = m2; corrected = fixed; }
        }
      }
      searchSql = c.sql; searchParams = c.params; fuzzy = c.fuzzy || !!corrected;
    }

    const conditions = searchSql ? [...base, searchSql] : base;
    const allParams = searchSql ? [...baseParams, ...searchParams] : baseParams;

    const rows = await db.all(
      `SELECT a.id, a.path, a.kind, a.taken_at, a.width, a.height, a.duration_s,
              a.gps_lat, a.gps_lon, a.fav, a.camera, a.live_video_id,
              p.name AS place_name, p.country AS place_country
       ${FROM}
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE WHEN a.taken_at IS NULL THEN 1 ELSE 0 END, a.taken_at DESC
       LIMIT ? OFFSET ?`,
      [...allParams, limit, offset]
    );

    const out = { assets: rows, offset, limit, fuzzy };
    if (corrected) out.corrected = corrected;
    if (count === '1') out.total = matchCount != null ? matchCount : await countMatches(conditions, allParams);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/asset/:id — full metadata for one asset (for the info panel)
router.get('/asset/:id', async (req, res) => {
  try {
    const row = await db.get(
      `SELECT a.*, p.name AS place_name, p.country AS place_country
       FROM assets a LEFT JOIN places p ON a.place_id = p.id
       WHERE a.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Expose just the filename too, for convenience
    row.filename = row.path ? row.path.split('/').pop() : null;
    row.tags = await db.all(
      `SELECT t.id, t.name FROM asset_tags at JOIN tags t ON t.id = at.tag_id
       WHERE at.asset_id = ? ORDER BY t.name`, [req.params.id]
    );
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/assets/index — lightweight index for the in-memory time slider.
// Only the fields the slider/grid actually use (id, taken_at, kind, fav). GPS is
// intentionally excluded — the Places screen uses the aggregated /places endpoint.
router.get('/assets/index', async (req, res) => {
  try {
    const extra = req.query.hideRaw === '1' ? rawExclusion('path') : { sql: '', params: [] };
    const rows = await db.all(
      `SELECT id, taken_at AS t, kind AS k, fav AS f, live_video_id AS lv FROM assets
       WHERE is_live_motion = 0 AND hidden = 0 AND duplicate_of IS NULL${extra.sql ? ' AND ' + extra.sql : ''}
       ORDER BY CASE WHEN taken_at IS NULL THEN 1 ELSE 0 END, taken_at DESC`,
      extra.params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/thumb/:id?size=grid|preview|cover
// Thumbnails are generated on demand (bounded concurrency) and cached to disk,
// so they build up gradually as the library is browsed — never all at once.
router.get('/thumb/:id', async (req, res) => {
  const size = req.query.size || 'grid';
  const cached = getThumbPath(req.params.id, size);

  if (fs.existsSync(cached)) {
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(cached);
  }

  try {
    const asset = await db.get('SELECT path, kind FROM assets WHERE id = ?', [req.params.id]);
    if (!asset) return res.status(404).json({ error: 'Not found' });

    const generated = await ensureThumb(req.params.id, asset.path, asset.kind, size);
    if (generated && fs.existsSync(generated)) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(generated);
    }
  } catch (_) {}

  res.status(404).json({ error: 'Thumbnail not available' });
});

// GET /api/aurora/video/:id — range-request streaming
router.get('/video/:id', async (req, res) => {
  try {
    const asset = await db.get('SELECT path, bytes FROM assets WHERE id = ? AND kind = ?', [req.params.id, 'video']);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    if (!fs.existsSync(asset.path)) return res.status(404).json({ error: 'File not found' });

    const stat = fs.statSync(asset.path);
    const total = stat.size;
    const range = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr);
      const end = endStr ? parseInt(endStr) : Math.min(start + 10 * 1024 * 1024, total - 1);
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': videoMimeType(asset.path)
      });
      fs.createReadStream(asset.path, { start, end }).pipe(res);
    } else {
      res.set({ 'Content-Length': total, 'Content-Type': videoMimeType(asset.path), 'Accept-Ranges': 'bytes' });
      fs.createReadStream(asset.path).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/original/:id — stream the original file (photo or video) with a
// correct content-type. Used by the Share feature to hand real files to the OS
// share sheet (AirDrop / Messages / Save to Photos on Apple devices).
const ORIGINAL_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
};
router.get('/original/:id', async (req, res) => {
  try {
    const asset = await db.get('SELECT path, kind FROM assets WHERE id = ?', [req.params.id]);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    if (!fs.existsSync(asset.path)) return res.status(404).json({ error: 'File not found' });
    const ext = path.extname(asset.path).toLowerCase();
    const ct = ORIGINAL_TYPES[ext] || (asset.kind === 'video' ? videoMimeType(asset.path) : 'application/octet-stream');
    const name = path.basename(asset.path).replace(/["\r\n]/g, '');
    const disp = req.query.dl ? 'attachment' : 'inline';   // ?dl=1 → force download (share fallback)
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `${disp}; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(asset.path).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/share/zip?ids=1,2,3 — stream a zip of the selected originals.
// This is the download fallback for the Share feature when the Web Share API isn't
// available (it requires HTTPS/localhost; Aurora is usually served over plain HTTP).
// Builds the archive from symlinks (zip follows them) so originals are never copied.
router.get('/share/zip', async (req, res) => {
  let staging = null, outZip = null;
  try {
    const ids = String(req.query.ids || '').split(',').map(n => parseInt(n, 10)).filter(Number.isFinite).slice(0, 200);
    if (!ids.length) return res.status(400).json({ error: 'ids required' });

    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.all(`SELECT id, path FROM assets WHERE id IN (${placeholders})`, ids);
    const files = rows.filter(r => { try { return fs.existsSync(r.path); } catch (_) { return false; } });
    if (!files.length) return res.status(404).json({ error: 'No files found' });

    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-share-'));
    const seen = new Set();
    for (const r of files) {
      let name = path.basename(r.path);
      if (seen.has(name.toLowerCase())) {                 // de-dupe basenames
        const dot = name.lastIndexOf('.');
        name = (dot > 0 ? name.slice(0, dot) : name) + '-' + r.id + (dot > 0 ? name.slice(dot) : '');
      }
      seen.add(name.toLowerCase());
      try { fs.symlinkSync(r.path, path.join(staging, name)); } catch (_) {}
    }

    outZip = path.join(os.tmpdir(), path.basename(staging) + '.zip');
    await new Promise((resolve, reject) => {
      execFile('zip', ['-q', '-j', '-r', outZip, staging], { timeout: 180000 }, (err) => err ? reject(err) : resolve());
    });

    const cleanup = () => {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(outZip, { force: true }); } catch (_) {}
    };
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="aurora-photos.zip"');
    const stream = fs.createReadStream(outZip);
    stream.on('error', () => { cleanup(); if (!res.headersSent) res.status(500).end(); });
    stream.on('close', cleanup);
    res.on('close', cleanup);
    stream.pipe(res);
  } catch (err) {
    try { if (staging) fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    try { if (outZip) fs.rmSync(outZip, { force: true }); } catch (_) {}
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/places
router.get('/places', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT p.id, p.name, p.country, p.lat, p.lon, COUNT(a.id) AS count,
              MIN(a.taken_at) AS first_date, MAX(a.taken_at) AS last_date
       FROM places p
       JOIN assets a ON a.place_id = p.id AND a.is_live_motion = 0 AND a.hidden = 0 AND a.duplicate_of IS NULL
       GROUP BY p.id ORDER BY count DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/worldmap — projected country outlines for the Places map
let worldMapCache = null;
router.get('/worldmap', (req, res) => {
  try {
    if (!worldMapCache) worldMapCache = require('../services/auroraWorldMapService').build();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json(worldMapCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/stats
router.get('/stats', async (req, res) => {
  try {
    const totals = await db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN kind='photo' THEN 1 ELSE 0 END) AS photos,
              SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END) AS videos,
              SUM(CASE WHEN fav=1 THEN 1 ELSE 0 END) AS favorites,
              SUM(bytes) AS total_bytes,
              MIN(taken_at) AS earliest,
              MAX(taken_at) AS latest
       FROM assets WHERE is_live_motion = 0 AND hidden = 0 AND duplicate_of IS NULL`
    );
    const places = await db.get('SELECT COUNT(*) AS count FROM places');
    res.json({ ...totals, place_count: places.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/cameras
router.get('/cameras', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT camera, COUNT(*) AS count FROM assets WHERE camera IS NOT NULL GROUP BY camera ORDER BY count DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/countries — distinct countries with photo counts (search facet)
router.get('/countries', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT p.country AS country, COUNT(a.id) AS count
       FROM places p JOIN assets a ON a.place_id = p.id AND a.is_live_motion = 0 AND a.hidden = 0 AND a.duplicate_of IS NULL
       WHERE p.country IS NOT NULL AND p.country != ''
       GROUP BY p.country ORDER BY count DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tags ─────────────────────────────────────────────────────────────────────

// GET /api/aurora/tags — all tags with how many (visible) assets carry them.
router.get('/tags', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT t.id, t.name, COUNT(a.id) AS count
       FROM tags t
       LEFT JOIN asset_tags at ON at.tag_id = t.id
       LEFT JOIN assets a ON a.id = at.asset_id AND a.is_live_motion = 0 AND a.hidden = 0 AND a.duplicate_of IS NULL
       GROUP BY t.id ORDER BY count DESC, t.name COLLATE NOCASE`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/tags/apply  { name, assetIds:[...] } — create tag if needed,
// attach it to the given assets. Used for manual tagging (one or many).
router.post('/tags/apply', async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    const assetIds = ((req.body && req.body.assetIds) || []).map(n => parseInt(n)).filter(Number.isFinite);
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!assetIds.length) return res.status(400).json({ error: 'assetIds required' });

    await db.run('INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)', [name, Date.now()]);
    const tag = await db.get('SELECT id, name FROM tags WHERE name = ?', [name]);
    let added = 0;
    for (const id of assetIds) {
      const r = await db.run(
        'INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, created_at) VALUES (?, ?, ?)',
        [id, tag.id, Date.now()]
      );
      added += r.changes || 0;
    }
    res.json({ tagId: tag.id, name: tag.name, added, requested: assetIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/tags/remove  { tagId, assetIds:[...] } — detach a tag from
// assets. A tag that ends up on nothing is deleted so the facet list stays clean.
router.post('/tags/remove', async (req, res) => {
  try {
    const tagId = parseInt(req.body && req.body.tagId);
    const assetIds = ((req.body && req.body.assetIds) || []).map(n => parseInt(n)).filter(Number.isFinite);
    if (!Number.isFinite(tagId) || !assetIds.length) return res.status(400).json({ error: 'tagId and assetIds required' });
    for (const id of assetIds) await db.run('DELETE FROM asset_tags WHERE tag_id = ? AND asset_id = ?', [tagId, id]);
    const left = (await db.get('SELECT COUNT(*) AS c FROM asset_tags WHERE tag_id = ?', [tagId])).c;
    if (left === 0) await db.run('DELETE FROM tags WHERE id = ?', [tagId]);
    res.json({ ok: true, remaining: left });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Smart tagging ──────────────────────────────────────────────────────────────
// Given a tag already on some photos, work out the "trip" it belongs to and find
// other photos that almost certainly belong to it too. The window is grown from
// the tagged photos' dates across any CONTIGUOUS run of shooting (gaps ≤ gapDays),
// which naturally captures a holiday and stops at the quiet stretch either side.
// If the tagged photos are concentrated in one country, candidates from a *different*
// country are excluded (un-located photos are kept — they're often holiday photos too).
async function computeSuggestion(tagId, { hideRaw = false, gapDays = 3 } = {}) {
  const tagged = await db.all(
    `SELECT a.taken_at AS t, p.country AS country
     FROM asset_tags at JOIN assets a ON a.id = at.asset_id
     LEFT JOIN places p ON a.place_id = p.id
     WHERE at.tag_id = ? AND a.taken_at IS NOT NULL`, [tagId]);
  if (!tagged.length) return null;

  let lo = Infinity, hi = -Infinity, geo = 0;
  const countryCount = new Map();
  for (const r of tagged) {
    if (r.t < lo) lo = r.t;
    if (r.t > hi) hi = r.t;
    if (r.country) { countryCount.set(r.country, (countryCount.get(r.country) || 0) + 1); geo++; }
  }
  let country = null, bestC = 0;
  for (const [c, n] of countryCount) if (n > bestC) { bestC = n; country = c; }
  if (!(geo > 0 && bestC / geo >= 0.5)) country = null; // only trust a clear majority

  // Find the "trip" window by walking outward from the seed over CONTIGUOUS photos
  // (gaps ≤ gapDays). When the tagged photos sit in one country, we cluster only
  // same-country photos — so the window snaps to the actual stay abroad instead of
  // sprawling across everyday shooting at home. With no clear country we fall back
  // to the whole timeline and hard-cap the span so a daily shooter can't run away.
  const GAP = gapDays * 86400000;
  const PAD = 90 * 86400000;
  const nearRows = country
    ? await db.all(
        `SELECT a.taken_at AS t FROM assets a JOIN places p ON a.place_id = p.id
         WHERE p.country = ? AND a.is_live_motion = 0 AND a.taken_at IS NOT NULL
           AND a.taken_at BETWEEN ? AND ? ORDER BY a.taken_at`, [country, lo - PAD, hi + PAD])
    : await db.all(
        `SELECT taken_at AS t FROM assets WHERE is_live_motion = 0 AND taken_at IS NOT NULL
           AND taken_at BETWEEN ? AND ? ORDER BY taken_at`, [lo - PAD, hi + PAD]);
  const near = nearRows.map(r => r.t);

  let winLo = lo, winHi = hi;
  for (const t of near) { if (t <= winHi) continue; if (t - winHi <= GAP) winHi = t; else break; }
  for (let i = near.length - 1; i >= 0; i--) { const t = near[i]; if (t >= winLo) continue; if (winLo - t <= GAP) winLo = t; else break; }
  if (!country) { const MAX = 21 * 86400000; winLo = Math.max(winLo, lo - MAX); winHi = Math.min(winHi, hi + MAX); }

  const conds = [
    'a.is_live_motion = 0',
    'a.taken_at BETWEEN ? AND ?',
    'NOT EXISTS (SELECT 1 FROM asset_tags x WHERE x.asset_id = a.id AND x.tag_id = ?)',
  ];
  const params = [winLo, winHi, tagId];
  if (country) { conds.push('p.country = ?'); params.push(country); }   // strict: only this country
  if (hideRaw) { const r = rawExclusion('a.path'); conds.push(r.sql); params.push(...r.params); }

  return { window: { from: winLo, to: winHi }, country, where: conds.join(' AND '), params };
}

// GET /api/aurora/tags/:tagId/suggest — preview of photos that look like the same trip.
router.get('/tags/:tagId/suggest', async (req, res) => {
  try {
    const s = await computeSuggestion(parseInt(req.params.tagId), { hideRaw: req.query.hideRaw === '1' });
    if (!s) return res.json({ total: 0, assets: [], window: null, country: null });
    const FROM = `FROM assets a LEFT JOIN places p ON a.place_id = p.id`;
    const total = (await db.get(`SELECT COUNT(*) AS c ${FROM} WHERE ${s.where}`, s.params)).c;
    const assets = await db.all(
      `SELECT a.id, a.kind, a.taken_at, a.live_video_id ${FROM} WHERE ${s.where}
       ORDER BY a.taken_at DESC LIMIT 60`, s.params);
    res.json({ window: s.window, country: s.country, total, assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/tags/:tagId/apply-suggestion  { hideRaw? } — tag the whole trip.
router.post('/tags/:tagId/apply-suggestion', async (req, res) => {
  try {
    const tagId = parseInt(req.params.tagId);
    const tag = await db.get('SELECT id, name FROM tags WHERE id = ?', [tagId]);
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    const s = await computeSuggestion(tagId, { hideRaw: !!(req.body && req.body.hideRaw) });
    if (!s) return res.json({ added: 0, tagId, name: tag.name });
    const r = await db.run(
      `INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, created_at)
       SELECT a.id, ?, ? FROM assets a LEFT JOIN places p ON a.place_id = p.id
       WHERE ${s.where}`, [tagId, Date.now(), ...s.params]);
    res.json({ added: r.changes || 0, tagId, name: tag.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/tags/rename  { tagId, name } — rename a tag everywhere. If the
// new name already exists, the two tags are MERGED (assets moved, old tag removed).
router.post('/tags/rename', async (req, res) => {
  try {
    const tagId = parseInt(req.body && req.body.tagId);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    if (!Number.isFinite(tagId) || !name) return res.status(400).json({ error: 'tagId and name required' });
    const tag = await db.get('SELECT id, name FROM tags WHERE id = ?', [tagId]);
    if (!tag) return res.status(404).json({ error: 'Tag not found' });

    const existing = await db.get('SELECT id FROM tags WHERE name = ? AND id != ?', [name, tagId]);
    if (existing) {
      // Merge tagId → existing (move assignments, then drop the old tag)
      await db.run(
        `INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, created_at)
         SELECT asset_id, ?, created_at FROM asset_tags WHERE tag_id = ?`, [existing.id, tagId]);
      await db.run('DELETE FROM asset_tags WHERE tag_id = ?', [tagId]);
      await db.run('DELETE FROM tags WHERE id = ?', [tagId]);
      return res.json({ ok: true, merged: true, tagId: existing.id, name });
    }
    await db.run('UPDATE tags SET name = ? WHERE id = ?', [name, tagId]);
    res.json({ ok: true, merged: false, tagId, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/tags/delete  { tagId } — remove a tag and all its assignments.
router.post('/tags/delete', async (req, res) => {
  try {
    const tagId = parseInt(req.body && req.body.tagId);
    if (!Number.isFinite(tagId)) return res.status(400).json({ error: 'tagId required' });
    await db.run('DELETE FROM asset_tags WHERE tag_id = ?', [tagId]);
    await db.run('DELETE FROM tags WHERE id = ?', [tagId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/tags/bulk  { op:'add'|'remove', name|tagId, assetIds:[...] }
// Add or remove a tag across many assets at once (multi-select). Chunked + wrapped
// in a transaction so even a large selection is one fast write.
router.post('/tags/bulk', async (req, res) => {
  try {
    const op = (req.body && req.body.op) || 'add';
    const assetIds = ((req.body && req.body.assetIds) || []).map(n => parseInt(n)).filter(Number.isFinite);
    if (!assetIds.length) return res.status(400).json({ error: 'assetIds required' });

    if (op === 'add') {
      const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'name required' });
      await db.run('INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)', [name, Date.now()]);
      const tag = await db.get('SELECT id, name FROM tags WHERE name = ?', [name]);
      const now = Date.now();
      let added = 0;
      // Each chunked multi-row INSERT is atomic on its own; no explicit transaction
      // (the shared DB connection may already be mid-transaction elsewhere).
      for (let i = 0; i < assetIds.length; i += 300) {
        const chunk = assetIds.slice(i, i + 300);
        const values = chunk.map(() => '(?, ?, ?)').join(',');
        const params = [];
        for (const id of chunk) params.push(id, tag.id, now);
        const r = await db.run(`INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, created_at) VALUES ${values}`, params);
        added += r.changes || 0;
      }
      return res.json({ op, tagId: tag.id, name: tag.name, added, requested: assetIds.length });
    }

    // remove
    const tagId = parseInt(req.body && req.body.tagId);
    if (!Number.isFinite(tagId)) return res.status(400).json({ error: 'tagId required for remove' });
    let removed = 0;
    for (let i = 0; i < assetIds.length; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      const qs = chunk.map(() => '?').join(',');
      const r = await db.run(`DELETE FROM asset_tags WHERE tag_id = ? AND asset_id IN (${qs})`, [tagId, ...chunk]);
      removed += r.changes || 0;
    }
    const left = (await db.get('SELECT COUNT(*) AS c FROM asset_tags WHERE tag_id = ?', [tagId])).c;
    if (left === 0) await db.run('DELETE FROM tags WHERE id = ?', [tagId]);
    res.json({ op, tagId, removed, remaining: left });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/tags/for-assets  { assetIds:[...] } — tags present on a selection
// (with how many of the selected carry each), so the UI can offer them for removal.
router.post('/tags/for-assets', async (req, res) => {
  try {
    const ids = ((req.body && req.body.assetIds) || []).map(n => parseInt(n)).filter(Number.isFinite);
    if (!ids.length) return res.json([]);
    const counts = new Map(), names = new Map();
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const qs = chunk.map(() => '?').join(',');
      const rows = await db.all(
        `SELECT t.id, t.name, COUNT(*) AS c FROM asset_tags at JOIN tags t ON t.id = at.tag_id
         WHERE at.asset_id IN (${qs}) GROUP BY t.id`, chunk);
      for (const r of rows) { counts.set(r.id, (counts.get(r.id) || 0) + r.c); names.set(r.id, r.name); }
    }
    const out = [...counts.entries()].map(([id, c]) => ({ id, name: names.get(id), count: c }))
      .sort((a, b) => b.count - a.count);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/fav/:id
router.post('/fav/:id', async (req, res) => {
  try {
    const asset = await db.get('SELECT id, fav FROM assets WHERE id = ?', [req.params.id]);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    const newFav = asset.fav ? 0 : 1;
    await db.run('UPDATE assets SET fav = ? WHERE id = ?', [newFav, req.params.id]);
    res.json({ fav: newFav });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/mount — mount a network share and return its local path
router.post('/mount', async (req, res) => {
  const { protocol, host, shareName, username, password, domain, localPath } = req.body;

  if (protocol === 'local') {
    if (!localPath) return res.status(400).json({ error: 'localPath required' });
    if (!fs.existsSync(localPath)) return res.status(400).json({ error: 'Path does not exist on server' });
    return res.json({ success: true, mountPoint: localPath });
  }

  if (!host || !shareName) return res.status(400).json({ error: 'host and shareName required' });

  const shareRecord = {
    id: `aurora_${Date.now()}`,
    protocol: protocol || 'smb',
    host,
    shareName,
    username: username || '',
    password: password || '',
    domain: domain || '',
    options: { readOnly: true }
  };

  // Race the mount against a hard 25s timeout so the browser never hangs
  const TIMEOUT_MS = 25000;
  let settled = false;
  const timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      res.status(504).json({ error: `Mount timed out after ${TIMEOUT_MS / 1000}s — check the host is reachable and the share name is correct` });
    }
  }, TIMEOUT_MS);

  try {
    const result = await mountShare(shareRecord);
    if (settled) return; // already timed out
    clearTimeout(timeoutId);
    settled = true;
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json({ success: true, mountPoint: result.mountPoint });
  } catch (err) {
    if (settled) return;
    clearTimeout(timeoutId);
    settled = true;
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/mounts — currently-mounted network shares, for the Import screen
router.get('/mounts', async (req, res) => {
  try {
    const raw = await listActiveMounts();
    const typeLabel = (fstype) => {
      const f = (fstype || '').toLowerCase();
      if (f === 'cifs' || f === 'smbfs' || f === 'smb3') return 'SMB';
      if (f.startsWith('nfs')) return 'NFS';
      if (f.includes('sshfs')) return 'SSHFS';
      return (fstype || 'unknown').toUpperCase();
    };
    const mounts = raw.map(m => ({
      path: m.target,
      source: m.source,
      type: typeLabel(m.fstype),
      fstype: m.fstype,
      readOnly: /(^|,)ro(,|$)/.test(m.options || '')
    }));
    res.json({ mounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/unmount { mountPoint }
router.post('/unmount', async (req, res) => {
  const { mountPoint } = req.body;
  if (!mountPoint) return res.status(400).json({ error: 'mountPoint required' });
  if (!mountPoint.startsWith(MOUNT_BASE)) {
    return res.status(400).json({ error: 'Refusing to unmount a path outside ' + MOUNT_BASE });
  }
  try {
    const result = await unmountShare(mountPoint);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/aurora/settings/metrics — DB / thumbnail / error stats for the Settings page
router.get('/settings/metrics', async (req, res) => {
  try {
    const lib = await db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN kind='photo' THEN 1 ELSE 0 END) AS photos,
              SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END) AS videos,
              SUM(CASE WHEN fav=1 THEN 1 ELSE 0 END) AS favorites,
              SUM(CASE WHEN taken_at IS NULL THEN 1 ELSE 0 END) AS undated,
              SUM(bytes) AS total_bytes,
              MIN(taken_at) AS earliest, MAX(taken_at) AS latest
       FROM assets WHERE is_live_motion = 0 AND hidden = 0 AND duplicate_of IS NULL`
    );
    const hiddenCount = await db.get('SELECT COUNT(*) AS count FROM assets WHERE hidden=1 AND is_live_motion=0');
    const dupCount = await db.get('SELECT COUNT(*) AS count FROM assets WHERE duplicate_of IS NOT NULL');
    const live = await db.get('SELECT COUNT(*) AS count FROM assets WHERE is_live_motion = 1');
    const places = await db.get('SELECT COUNT(*) AS count FROM places');

    // DB file size on disk (data + WAL + shared-memory)
    let dbBytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try { dbBytes += fs.statSync(db.DB_PATH + suffix).size; } catch (_) {}
    }

    // Thumbnail cache: exact count (cheap), sampled byte estimate (avoids statting
    // 100K+ files on every page load)
    let thumbCount = 0, thumbBytesApprox = 0;
    try {
      const files = fs.readdirSync(THUMB_DIR);
      thumbCount = files.length;
      let sBytes = 0, sN = 0;
      for (const f of files.slice(0, 500)) {
        try { sBytes += fs.statSync(path.join(THUMB_DIR, f)).size; sN++; } catch (_) {}
      }
      if (sN) thumbBytesApprox = Math.round((sBytes / sN) * thumbCount);
    } catch (_) {}

    const sessions = await db.all(
      `SELECT id, source_path, started_at, finished_at, status, scanned, indexed, skipped, errors
       FROM import_sessions ORDER BY started_at DESC LIMIT 10`
    );
    const errAgg = await db.get(
      `SELECT COALESCE(SUM(errors),0) AS total_errors,
              COALESCE(SUM(CASE WHEN status='interrupted' THEN 1 ELSE 0 END),0) AS interrupted
       FROM import_sessions`
    );

    res.json({
      library: { ...lib, live_photos: live.count, places: places.count, db_bytes: dbBytes, hidden: hiddenCount.count, duplicates_hidden: dupCount.count },
      thumbnails: { count: thumbCount, bytes_approx: thumbBytesApprox, warm: getWarmState() },
      imports: { recent: sessions, total_errors: errAgg.total_errors, interrupted: errAgg.interrupted }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/settings/relink-live — re-pair Live Photos (idempotent)
router.post('/settings/relink-live', async (req, res) => {
  try {
    res.json(await linkLivePhotos());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/settings/geocode-places  { all?: bool }
// (Re-)resolve place names from the offline cities dataset. By default only fills
// places that have no name yet (e.g. imported before cities.tsv was present);
// pass all=true to re-resolve every place. Idempotent and safe to re-run.
router.post('/settings/geocode-places', async (req, res) => {
  try {
    const all = !!(req.body && req.body.all);
    await geocoder.reload(); // pick up a cities.tsv added since startup
    if (geocoder.size() === 0) {
      return res.status(400).json({ error: 'No cities dataset found at data/cities.tsv — place names can\'t be resolved.' });
    }
    const rows = await db.all(`SELECT id, lat, lon FROM places${all ? '' : ' WHERE name IS NULL'}`);
    let named = 0;
    for (const p of rows) {
      if (p.lat == null || p.lon == null) continue;
      let name = null, country = null;
      try { const r = await geocoder.lookup(p.lat, p.lon); if (r) { name = r.name; country = r.country; } } catch (_) {}
      await db.run('UPDATE places SET name = ?, country = ? WHERE id = ?', [name, country, p.id]);
      if (name) named++;
    }
    res.json({ ok: true, processed: rows.length, named, cities: geocoder.size() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aurora/warm — start background thumbnail warming
router.post('/warm', (req, res) => {
  const state = startThumbnailWarming();
  res.json(state);
});

// GET /api/aurora/warm/status
router.get('/warm/status', (req, res) => {
  res.json(getWarmState());
});

// POST /api/aurora/import
// `force: true` re-reads metadata for files already indexed (used by the Settings
// "Re-index metadata" action so the improved date extraction is applied to an
// existing library). Requires the source share to be mounted.
router.post('/import', async (req, res) => {
  const { sourcePath, force } = req.body;
  if (!sourcePath) return res.status(400).json({ error: 'sourcePath required' });
  if (!fs.existsSync(sourcePath)) return res.status(400).json({ error: 'Path does not exist' });

  const sessionId = Date.now();
  startImport(sourcePath, sessionId, { force: !!force });
  res.json({ sessionId });
});

// GET /api/aurora/import/progress/:sessionId
router.get('/import/progress/:sessionId', (req, res) => {
  const session = getSession(parseInt(req.params.sessionId));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// GET /api/aurora/import/progress/:sessionId/stream — SSE
router.get('/import/progress/:sessionId/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering

  const sessionId = parseInt(req.params.sessionId);
  const send = () => {
    const session = getSession(sessionId);
    if (!session) { res.write('data: {"error":"not found"}\n\n'); return; }
    // Send summary only — never the full log array (it grows to MB at 50K files)
    const summary = {
      status: session.status,
      scanned: session.scanned,
      indexed: session.indexed,
      skipped: session.skipped,
      errors: session.errors,
      // Send only the last 5 log lines
      recentLog: session.log.slice(-5)
    };
    try {
      res.write(`data: ${JSON.stringify(summary)}\n\n`);
    } catch (_) { clearInterval(interval); return; }
    if (session.status === 'complete' || session.status === 'error') clearInterval(interval);
  };

  send();
  const interval = setInterval(send, 500);
  req.on('close', () => clearInterval(interval));
});

// GET /api/aurora/albums
router.get('/albums', async (req, res) => {
  try {
    // Smart albums (saved queries). Live Photo clips are excluded everywhere.
    const BASE_COND = 'is_live_motion=0 AND hidden=0 AND duplicate_of IS NULL';
    const favorites = await db.get(`SELECT COUNT(*) AS count FROM assets WHERE fav=1 AND ${BASE_COND}`);
    const videos = await db.get(`SELECT COUNT(*) AS count FROM assets WHERE kind="video" AND ${BASE_COND}`);
    const recent = await db.get(`SELECT COUNT(*) AS count FROM assets WHERE ${BASE_COND} AND taken_at > ?`, [Date.now() - 30 * 24 * 3600 * 1000]);
    const hidden = await db.get('SELECT COUNT(*) AS count FROM assets WHERE hidden=1 AND is_live_motion=0');

    // Auto-events: group by year/month
    const events = await db.all(
      `SELECT strftime('%Y-%m', datetime(taken_at/1000, 'unixepoch')) AS month,
              COUNT(*) AS count,
              MIN(id) AS cover_id,
              MIN(taken_at) AS first_date,
              MAX(taken_at) AS last_date
       FROM assets
       WHERE taken_at IS NOT NULL AND ${BASE_COND}
       GROUP BY month
       ORDER BY month DESC
       LIMIT 48`
    );

    res.json({
      smart: [
        { id: 'favorites', name: 'Favorites', icon: 'heart', count: favorites.count, query: { fav: '1' } },
        { id: 'videos', name: 'Videos', icon: 'film', count: videos.count, query: { kind: 'video' } },
        { id: 'recent', name: 'Recent 30 days', icon: 'clock', count: recent.count, query: { from: Date.now() - 30 * 24 * 3600 * 1000 } },
        { id: 'hidden', name: 'Hidden', icon: 'lock', count: hidden.count, query: { showHidden: '1' } },
      ],
      events
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Software update ──────────────────────────────────────────────────────────
//
// The update flow is:
//   1. Client POSTs a local zip path to /api/aurora/settings/update/apply
//   2. This endpoint validates + extracts the zip to a staging dir
//   3. A detached bash script (apply-update.sh) is spawned to:
//      stop the service → swap code files → npm install → start service
//   4. Progress is tracked in update-status.json in the data dir (survives restart)
//   5. Client polls /api/aurora/settings/update/status until complete

const DATA_ROOT = process.env.AURORA_DATA_ROOT || path.join(__dirname, '../../../');
const INSTALL_DIR = process.env.AURORA_INSTALL_DIR || path.join(__dirname, '../../');
const UPDATE_STATUS_FILE = path.join(DATA_ROOT, 'update-status.json');
const UPDATER_SCRIPT = path.join(INSTALL_DIR, 'scripts/apply-update.sh');

// Allowed top-level items that an update zip may replace (data dirs are never listed)
const UPDATABLE_ITEMS = new Set(['server.js', 'package.json', 'package-lock.json', 'version.json', 'src', 'views', 'public', 'scripts']);

function readUpdateStatus() {
  try { return JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf8')); }
  catch (_) { return { status: 'idle', message: '', ts: 0 }; }
}

// GET /api/aurora/settings/update/status
router.get('/settings/update/status', (req, res) => {
  res.json(readUpdateStatus());
});

// POST /api/aurora/settings/update/apply  { zipPath: '/absolute/path/to/update.zip' }
router.post('/settings/update/apply', async (req, res) => {
  const { zipPath } = req.body;

  if (!zipPath) return res.status(400).json({ error: 'zipPath required' });
  if (!path.isAbsolute(zipPath)) return res.status(400).json({ error: 'zipPath must be an absolute path' });
  if (!fs.existsSync(zipPath)) return res.status(400).json({ error: 'Zip file not found: ' + zipPath });
  if (!zipPath.endsWith('.zip')) return res.status(400).json({ error: 'File must be a .zip archive' });

  // Reject if an update is already in progress
  const current = readUpdateStatus();
  if (['stopping', 'applying', 'deps', 'starting'].includes(current.status)) {
    return res.status(409).json({ error: 'An update is already in progress', status: current.status });
  }

  // Ensure the updater script exists
  if (!fs.existsSync(UPDATER_SCRIPT)) {
    return res.status(500).json({ error: 'Update script not found at ' + UPDATER_SCRIPT });
  }

  // Extract to a temp staging dir and validate the zip contents
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-update-'));
  try {
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-q', zipPath, '-d', stagingDir], { timeout: 60000 }, (err) => {
        if (err) reject(new Error('Failed to unzip: ' + err.message));
        else resolve();
      });
    });

    // Accept either the files at root OR nested one level inside a single directory
    let effectiveRoot = stagingDir;
    const topEntries = fs.readdirSync(stagingDir);
    if (topEntries.length === 1) {
      const single = path.join(stagingDir, topEntries[0]);
      if (fs.statSync(single).isDirectory()) effectiveRoot = single;
    }

    // Must contain server.js — sanity check it's an Aurora update
    if (!fs.existsSync(path.join(effectiveRoot, 'server.js'))) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'Invalid update zip: server.js not found inside the archive' });
    }

    // Read version from the zip before we apply it
    let newVersion = 'unknown';
    try {
      const vj = path.join(effectiveRoot, 'version.json');
      if (fs.existsSync(vj)) newVersion = JSON.parse(fs.readFileSync(vj, 'utf8')).version || 'unknown';
    } catch (_) {}

    // Write initial status before we spawn
    fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ status: 'stopping', message: 'Update triggered — installing v' + newVersion, ts: Date.now() }));

    // Launch via systemd-run so the update script runs in its OWN transient unit,
    // completely outside the aurora-photos.service cgroup. Without this, systemd's
    // cgroup cleanup when it stops the service would kill the update script too.
    const child = spawn('systemd-run', [
      '--no-ask-password',
      '--unit=aurora-update',
      '--description=Aurora Photos software update',
      `--setenv=INSTALL_DIR=${INSTALL_DIR}`,
      `--setenv=DATA_DIR=${DATA_ROOT}`,
      'bash', UPDATER_SCRIPT, effectiveRoot
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    return res.json({ ok: true, message: 'Update triggered — installing v' + newVersion, stagingDir });
  } catch (err) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    return res.status(500).json({ error: err.message });
  }
});

// ── Privacy (hidden photos) ─────────────────────────────────────────────────

// POST /api/aurora/assets/privacy  { assetIds, hidden: 1|0 }
router.post('/assets/privacy', async (req, res) => {
  try {
    const hidden = (req.body && req.body.hidden) ? 1 : 0;
    const assetIds = ((req.body && req.body.assetIds) || []).map(n => parseInt(n)).filter(Number.isFinite);
    if (!assetIds.length) return res.status(400).json({ error: 'assetIds required' });
    for (let i = 0; i < assetIds.length; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      const qs = chunk.map(() => '?').join(',');
      await db.run(`UPDATE assets SET hidden = ? WHERE id IN (${qs})`, [hidden, ...chunk]);
    }
    res.json({ ok: true, hidden, count: assetIds.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/aurora/settings/passcode/verify  { passcode }
router.post('/settings/passcode/verify', async (req, res) => {
  try {
    const passcode = String((req.body && req.body.passcode) || '');
    const stored = await db.get(`SELECT value FROM app_settings WHERE key = 'private_passcode'`);
    res.json({ ok: !!(stored && stored.value === passcode) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/aurora/settings/passcode/set  { passcode }
router.post('/settings/passcode/set', async (req, res) => {
  try {
    const passcode = String((req.body && req.body.passcode) || '').slice(0, 20);
    if (!passcode) return res.status(400).json({ error: 'passcode required' });
    await db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('private_passcode', ?)`, [passcode]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/aurora/settings/privacy/stats
router.get('/settings/privacy/stats', async (req, res) => {
  try {
    const h = await db.get('SELECT COUNT(*) AS count FROM assets WHERE hidden = 1 AND is_live_motion = 0');
    const d = await db.get('SELECT COUNT(*) AS count FROM assets WHERE duplicate_of IS NOT NULL');
    res.json({ hidden: h.count, duplicates_hidden: d.count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Duplicate detection ──────────────────────────────────────────────────────

let dupScan = { running: false, total: 0, done: 0, groups: 0, error: null };

function runDupScan() {
  if (dupScan.running) return;
  dupScan = { running: true, total: 0, done: 0, groups: 0, error: null };
  (async () => {
    try {
      const assets = await db.all('SELECT id, path FROM assets WHERE is_live_motion = 0 ORDER BY id');
      dupScan.total = assets.length;
      const hashMap = new Map();
      for (const asset of assets) {
        if (!dupScan.running) break;
        try {
          if (!fs.existsSync(asset.path)) { dupScan.done++; continue; }
          // Stream first 64 KB — fast, unique enough for photos
          const hash = await new Promise((resolve, reject) => {
            const h = crypto.createHash('sha256');
            const stream = fs.createReadStream(asset.path, { start: 0, end: 65535 });
            stream.on('data', d => h.update(d));
            stream.on('end', () => resolve(h.digest('hex')));
            stream.on('error', reject);
          });
          await db.run('UPDATE assets SET file_hash = ? WHERE id = ?', [hash, asset.id]);
          if (!hashMap.has(hash)) hashMap.set(hash, []);
          hashMap.get(hash).push(asset.id);
        } catch (_) {}
        dupScan.done++;
      }
      let groups = 0;
      for (const ids of hashMap.values()) if (ids.length > 1) groups++;
      dupScan.groups = groups;
      dupScan.running = false;
    } catch (err) {
      dupScan.error = err.message;
      dupScan.running = false;
    }
  })();
}

// POST /api/aurora/settings/duplicates/scan
router.post('/settings/duplicates/scan', (req, res) => {
  if (dupScan.running) return res.json({ already: true, ...dupScan });
  runDupScan();
  res.json({ started: true });
});

// GET /api/aurora/settings/duplicates/status
router.get('/settings/duplicates/status', (req, res) => res.json(dupScan));

// GET /api/aurora/settings/duplicates  — groups of duplicate assets
router.get('/settings/duplicates', async (req, res) => {
  try {
    const groups = await db.all(
      `SELECT file_hash, COUNT(*) AS count FROM assets
       WHERE file_hash IS NOT NULL AND is_live_motion = 0 AND duplicate_of IS NULL
       GROUP BY file_hash HAVING count > 1
       ORDER BY count DESC LIMIT 100`
    );
    const result = [];
    for (const g of groups) {
      const assets = await db.all(
        `SELECT a.id, a.path, a.taken_at, a.bytes, a.width, a.height, a.camera
         FROM assets a WHERE a.file_hash = ? AND a.duplicate_of IS NULL AND a.is_live_motion = 0
         ORDER BY a.taken_at ASC, a.id ASC`, [g.file_hash]
      );
      if (assets.length > 1) result.push({ hash: g.file_hash, count: assets.length, assets });
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/aurora/settings/duplicates/resolve  { keepId, removeIds }
router.post('/settings/duplicates/resolve', async (req, res) => {
  try {
    const keepId = parseInt(req.body && req.body.keepId);
    const removeIds = ((req.body && req.body.removeIds) || []).map(n => parseInt(n)).filter(Number.isFinite);
    if (!Number.isFinite(keepId) || !removeIds.length) return res.status(400).json({ error: 'keepId and removeIds required' });
    await db.run('UPDATE assets SET duplicate_of = NULL WHERE id = ?', [keepId]);
    for (let i = 0; i < removeIds.length; i += 500) {
      const chunk = removeIds.slice(i, i + 500);
      await db.run(`UPDATE assets SET duplicate_of = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, [keepId, ...chunk]);
    }
    res.json({ ok: true, removed: removeIds.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/aurora/settings/duplicates/resolve-all  — auto-keep largest in every group
router.post('/settings/duplicates/resolve-all', async (req, res) => {
  try {
    const groups = await db.all(
      `SELECT file_hash FROM assets
       WHERE file_hash IS NOT NULL AND is_live_motion = 0 AND duplicate_of IS NULL
       GROUP BY file_hash HAVING COUNT(*) > 1`
    );
    let resolved = 0, removed = 0;
    for (const g of groups) {
      const assets = await db.all(
        `SELECT id, bytes FROM assets WHERE file_hash = ? AND duplicate_of IS NULL AND is_live_motion = 0
         ORDER BY COALESCE(bytes,0) DESC, id ASC`, [g.file_hash]
      );
      if (assets.length < 2) continue;
      const keepId = assets[0].id;
      const removeIds = assets.slice(1).map(a => a.id);
      await db.run('UPDATE assets SET duplicate_of = NULL WHERE id = ?', [keepId]);
      for (let i = 0; i < removeIds.length; i += 500) {
        const chunk = removeIds.slice(i, i + 500);
        await db.run(`UPDATE assets SET duplicate_of = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, [keepId, ...chunk]);
      }
      resolved++;
      removed += removeIds.length;
    }
    res.json({ ok: true, groups: resolved, removed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/aurora/settings/duplicates/unmark  { assetIds }
router.post('/settings/duplicates/unmark', async (req, res) => {
  try {
    const assetIds = ((req.body && req.body.assetIds) || []).map(n => parseInt(n)).filter(Number.isFinite);
    if (!assetIds.length) return res.status(400).json({ error: 'assetIds required' });
    for (let i = 0; i < assetIds.length; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      await db.run(`UPDATE assets SET duplicate_of = NULL WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
