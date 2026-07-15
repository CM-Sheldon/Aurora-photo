// ── Aurora caption service: natural-language photo descriptions ───────────────
//
// Generates one short, factual caption per photo using a vision-LLM on a remote
// Ollama server, so the library can be searched in plain English ("girl holding a
// coffee"). Single background worker, resumable via assets.captioned_at, pauses
// during imports, stoppable from the UI — does NO machine learning locally: it
// just fetches a JPEG, calls Ollama over HTTP, and stores the returned text. All
// the heavy ML stays on the Ollama box.
//
// Captions are stored in `asset_captions` + `captions_fts` (see auroraDbService.js)
// and made keyword-searchable via the search engine (tokenClause in routes/aurora.js).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const db = require('./auroraDbService');
const indexer = require('./auroraIndexerService');

// ── Durable caption sidecar (recovery from DB loss / photo re-import) ─────────
// Every caption save also appends one JSON line here, keyed by content_hash +
// file_hash + path — none of which change on re-import. Rebuilding the DB from
// scratch means grepping this file for the photo's hash, not re-running the
// weeks-long captioning pass. Failure to write the sidecar is logged but does
// NOT fail the DB save (fire-and-forget).
const SIDECAR_DIR = process.env.AURORA_CAPTION_SIDECAR_DIR || '/var/lib/aurora-photos/backups';
const SIDECAR_FILE = path.join(SIDECAR_DIR, 'captions.live.jsonl');
let sidecarDirEnsured = false;
async function appendCaptionSidecar(record) {
  try {
    if (!sidecarDirEnsured) {
      await fs.promises.mkdir(SIDECAR_DIR, { recursive: true });
      sidecarDirEnsured = true;
    }
    await fs.promises.appendFile(SIDECAR_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('[captions] sidecar append failed:', err.message);
  }
}

// Only the visible photo library; clips/duplicates/hidden are excluded (and stay
// pending, so an un-hidden/un-duplicated photo gets picked up later). Mirrors the
// vision service's PENDING_WHERE but on the captioned_at cursor.
const VISIBLE = "kind='photo' AND is_live_motion=0 AND hidden=0 AND duplicate_of IS NULL";
const PENDING_WHERE = `captioned_at IS NULL AND ${VISIBLE}`;

const OLLAMA_TIMEOUT_MS = parseInt(process.env.AURORA_CAPTION_TIMEOUT_MS) || 120000;
const FAIL_LIMIT = 8;            // consecutive failures → stop with an error (Ollama down/misconfigured)
const LOG_KEEP = 15;             // recent activity entries surfaced to the UI

// ── Caption styles (the "what kind of caption" knob shown in the UI) ──────────
// Each maps to a prompt + sampling temperature. Lower temperature = more literal.
const STYLES = {
  concise: {
    label: 'Concise (one sentence)',
    temperature: 0.2,
    prompt: 'Describe this photo in ONE short, factual sentence for search. Name the main ' +
      'subject(s) and what they are doing. Be literal. Do not guess names or emotions.',
  },
  balanced: {
    label: 'Balanced (1–2 sentences + keywords)',
    temperature: 0.2,
    prompt: 'Describe this photo in 1-2 plain factual sentences for SEARCH. Name the main ' +
      'subjects, what they are doing, objects they hold or use, and the setting. Be literal ' +
      'and concise. Do not guess names or emotions. Then add a line starting with ' +
      '"Keywords:" listing 5-10 single search words separated by commas.',
  },
  detailed: {
    label: 'Detailed (2–3 sentences + keywords)',
    temperature: 0.2,
    prompt: 'Describe this photo in 2-3 factual sentences for SEARCH. Name every visible ' +
      'subject, their actions, objects they hold or use, clothing and colours, and the type ' +
      'of setting or location. Be literal and specific. Do not guess names or emotions. Then ' +
      'add a line starting with "Keywords:" listing 8-15 single search words separated by commas.',
  },
  keywords: {
    label: 'Keywords only',
    temperature: 0.3,
    prompt: 'List 10-20 specific search keywords describing this photo: main subjects, objects, ' +
      'actions, setting or location type, and notable colours. Output ONLY the keywords, ' +
      'comma-separated, lowercase, with no sentences.',
  },
};

const DEFAULT_CFG = {
  // Points at Ollama on the same host by default. Set this in Settings → Manage →
  // Photo descriptions (or via AURORA_CAPTION_OLLAMA) if your Ollama runs elsewhere.
  url: process.env.AURORA_CAPTION_OLLAMA || 'http://localhost:11434',
  model: process.env.AURORA_CAPTION_MODEL || 'qwen2.5vl:3b',
  style: 'balanced',
  concurrency: 1,
};

// In-memory runtime state (counts captioned/total are added by the route from the DB).
const captionState = {
  running: false,
  phase: 'idle',          // idle | running | paused | complete | stopped | error
  done: 0,                // captioned this session
  skipped: 0,             // skipped this session (no usable thumbnail — see captionOne)
  error: null,
  model: null,
  consecutiveFailures: 0,
  last: null,             // { assetId, caption, at } — most recent success (for the preview)
  log: [],                // recent [{ assetId, caption|null, ok, error?, at }] newest-first
};

// True from the moment the loop IIFE starts until its finally runs. Distinct from
// `running` (the stop signal): after Stop, `running` is false but the loop is still
// draining its in-flight image, so we must not let a second loop start on top of it.
let loopActive = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || lo));

function pushLog(entry) {
  captionState.log.unshift(entry);
  if (captionState.log.length > LOG_KEEP) captionState.log.length = LOG_KEEP;
}

// ── Config (persisted in app_settings so it survives restarts) ────────────────
async function getSetting(key, dflt) {
  try {
    const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
    return row && row.value != null && row.value !== '' ? row.value : dflt;
  } catch (_) { return dflt; }
}
async function setSetting(key, value) {
  await db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, String(value)]);
}
async function getConfig() {
  return {
    url: await getSetting('caption_ollama_url', DEFAULT_CFG.url),
    model: await getSetting('caption_model', DEFAULT_CFG.model),
    style: await getSetting('caption_style', DEFAULT_CFG.style),
    concurrency: clampInt(await getSetting('caption_concurrency', DEFAULT_CFG.concurrency), 1, 4),
  };
}
async function setConfig(patch = {}) {
  if (patch.url != null) {
    let u = String(patch.url).trim();
    if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;       // tolerate "host:port"
    await setSetting('caption_ollama_url', u || DEFAULT_CFG.url);
  }
  if (patch.model != null) await setSetting('caption_model', String(patch.model).trim().slice(0, 80) || DEFAULT_CFG.model);
  if (patch.style != null) await setSetting('caption_style', STYLES[patch.style] ? patch.style : DEFAULT_CFG.style);
  if (patch.concurrency != null) await setSetting('caption_concurrency', String(clampInt(patch.concurrency, 1, 4)));
  return getConfig();
}
function getStyles() {
  return Object.entries(STYLES).map(([key, s]) => ({ key, label: s.label }));
}

// ── Caption persistence (also reused by POST /captions/ingest for external workers) ──
async function saveCaption(assetId, caption, model) {
  const now = Date.now();
  await db.run(
    `INSERT INTO asset_captions (asset_id, caption, model, captioned_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET caption=excluded.caption, model=excluded.model, captioned_at=excluded.captioned_at`,
    [assetId, caption, model, now]
  );
  // Keep the FTS index in sync (rowid = asset_id): drop any prior row, re-insert.
  await db.run('DELETE FROM captions_fts WHERE rowid = ?', [assetId]);
  if (caption) await db.run('INSERT INTO captions_fts(rowid, caption) VALUES (?, ?)', [assetId, caption]);
  // Advance the resumable cursor so the photo leaves the pending queue.
  await db.run('UPDATE assets SET captioned_at = ? WHERE id = ?', [now, assetId]);
  // Durable sidecar: keep the caption paired with re-import-stable keys so a
  // corrupted DB or re-scanned library can be re-linked. Best-effort; a sidecar
  // I/O error must not fail the DB save the user just paid for.
  try {
    const a = await db.get('SELECT path, content_hash, file_hash FROM assets WHERE id = ?', [assetId]);
    await appendCaptionSidecar({
      asset_id: assetId,
      caption,
      model,
      captioned_at: now,
      path: a && a.path || null,
      content_hash: a && a.content_hash || null,
      file_hash: a && a.file_hash || null,
    });
  } catch (err) {
    console.error('[captions] sidecar prep failed:', err.message);
  }
}

// No usable image for this photo (e.g. an undecodable RAW with no thumbnail). Advance
// the cursor so it leaves the pending queue and the run can finish — but write NO
// asset_captions / captions_fts row, so we never store a bogus caption. By construction
// a photo with assets.captioned_at set yet no asset_captions row is one we skipped, so a
// later maintenance pass (or a future thumbnailer) can find and retry them without
// disturbing any real caption:
//   SELECT id FROM assets WHERE captioned_at IS NOT NULL
//     AND id NOT IN (SELECT asset_id FROM asset_captions);
async function markSkipped(assetId) {
  await db.run('UPDATE assets SET captioned_at = ? WHERE id = ?', [Date.now(), assetId]);
}

// ── Image + Ollama I/O ────────────────────────────────────────────────────────
// Vision models reject webp, so we transcode the cached 2048px thumb to JPEG.
// Returns null (rather than throwing) when the photo has no usable thumbnail — e.g.
// an undecodable RAW the indexer can't make a preview for. That's a permanent per-photo
// gap, NOT a service failure, so the caller skips the photo instead of counting it
// toward the Ollama circuit breaker (see captionOne).
async function fetchJpegBase64(row) {
  let webp = indexer.getThumbPath(row.id, 'full');
  if (!fs.existsSync(webp)) {
    try { webp = await indexer.ensureThumb(row.id, row.path, row.kind, 'full'); } catch (_) { webp = null; }
  }
  if (!webp || !fs.existsSync(webp)) return null;
  const jpeg = await sharp(webp).jpeg({ quality: 82 }).toBuffer();
  return jpeg.toString('base64');
}

async function callOllama(url, model, style, b64) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt: style.prompt, images: [b64], stream: false,
        options: { temperature: style.temperature },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j && j.error ? (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)) : '';
      } catch (_) {}
      throw new Error(`Ollama HTTP ${res.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
    }
    const j = await res.json();
    return (j && j.response ? String(j.response) : '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Ollama request timed out');
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(err.message)) {
      throw new Error('cannot reach Ollama server (' + url + ')');
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Test reachability + list vision-capable models (for the UI dropdown / Test button).
async function listModels(url) {
  const base = String(url || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(base + '/api/tags', { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const models = (j.models || []).map((m) => {
      const caps = m.capabilities || [];
      const vision = caps.includes('vision') || /(\bvl\b|llava|vision|moondream|bakllava|minicpm-v)/i.test(m.name || '');
      return { name: m.name, vision, params: (m.details && m.details.parameter_size) || null, size: m.size || null };
    });
    return { ok: true, models };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timed out' : err.message;
    return { ok: false, error: msg, models: [] };
  } finally {
    clearTimeout(t);
  }
}

// ── Worker pool over one page of pending photos ───────────────────────────────
async function runPool(items, n, worker) {
  let i = 0;
  const runner = async () => {
    while (i < items.length && captionState.running) {
      await worker(items[i++]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, runner));
}

async function captionOne(cfg, style, row) {
  if (!captionState.running) return;
  try {
    const b64 = await fetchJpegBase64(row);
    // Photos with no usable thumbnail (e.g. an undecodable RAW) can never be captioned by
    // this pipeline. SKIP them: advance the cursor so the photo leaves the pending queue
    // and the loop keeps moving, but write no caption — and return BEFORE the failure
    // path below so consecutiveFailures is untouched. The circuit breaker exists to catch
    // a down/misconfigured Ollama; a cluster of un-thumbnailable RAWs must not look like
    // that and stop the run. (A corrupt cached thumb still throws from sharp and is caught
    // below as a normal, retryable failure — only a genuinely absent image is skipped.)
    if (b64 == null) {
      await markSkipped(row.id);
      captionState.skipped++;
      pushLog({ assetId: row.id, ok: false, skipped: true, error: 'no thumbnail — skipped', at: Date.now() });
      return;
    }
    const caption = await callOllama(cfg.url, cfg.model, style, b64);
    if (!caption) throw new Error('model returned an empty caption');
    await saveCaption(row.id, caption, cfg.model);
    captionState.done++;
    captionState.consecutiveFailures = 0;
    const at = Date.now();
    captionState.last = { assetId: row.id, caption, at };
    pushLog({ assetId: row.id, caption, ok: true, at });
  } catch (err) {
    captionState.consecutiveFailures++;
    pushLog({ assetId: row.id, ok: false, error: err.message, at: Date.now() });
    // Leave captioned_at NULL so it retries next pass. Trip a circuit breaker if
    // failures pile up (e.g. Ollama down / wrong model) rather than spinning forever.
    if (captionState.consecutiveFailures >= FAIL_LIMIT) {
      throw new Error(`stopped after ${FAIL_LIMIT} consecutive failures — ${err.message}`);
    }
    await sleep(1500);
  }
}

function startCaptioning() {
  // Refuse if a run is active OR still draining a stop — avoids two concurrent loops.
  if (captionState.running || loopActive) return captionState;
  loopActive = true;
  captionState.running = true;
  captionState.phase = 'starting';
  captionState.error = null;
  captionState.done = 0;
  captionState.skipped = 0;
  captionState.consecutiveFailures = 0;
  captionState.last = null;
  captionState.log = [];

  (async () => {
    try {
      const cfg = await getConfig();
      const style = STYLES[cfg.style] || STYLES.balanced;
      captionState.model = cfg.model;
      const page = Math.max(8, cfg.concurrency * 3);

      while (captionState.running) {
        if (indexer.isIndexing()) { captionState.phase = 'paused'; await sleep(4000); continue; }
        captionState.phase = 'running';

        const rows = await db.all(
          `SELECT id, path, kind FROM assets WHERE ${PENDING_WHERE} ORDER BY id LIMIT ?`, [page]
        );
        if (!rows.length) { captionState.phase = 'complete'; break; }

        await runPool(rows, cfg.concurrency, (r) => captionOne(cfg, style, r));
      }
    } catch (err) {
      captionState.phase = 'error';
      captionState.error = err.message;
    } finally {
      captionState.running = false;
      loopActive = false;
      // Anything that isn't a natural finish or a hard error means we were stopped.
      if (captionState.phase !== 'complete' && captionState.phase !== 'error') {
        captionState.phase = 'stopped';
      }
    }
  })();

  return captionState;
}

function stopCaptioning() {
  // Signal the loop to stop; it finishes the in-flight image then exits. Surface a
  // 'stopping' phase for that drain window so the UI shows "Stopping…" not "Running".
  if (captionState.running) {
    captionState.running = false;
    captionState.phase = 'stopping';
  }
  return captionState;
}

function getCaptionState() { return captionState; }

module.exports = {
  startCaptioning, stopCaptioning, getCaptionState,
  getConfig, setConfig, getStyles, listModels, saveCaption,
};
