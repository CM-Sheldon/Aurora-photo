#!/usr/bin/env node
/**
 * Aurora caption worker — offload the ML orchestration to a beefier host that
 * runs Ollama (e.g. a Mac with an M-series chip, a workstation with a GPU, or
 * anything else that can serve Ollama over HTTP). NOT run on the Aurora box.
 *
 * Pulls un-captioned photos from Aurora, asks an Ollama vision-LLM to describe each
 * one in plain English, and pushes the caption back. Aurora stores the text and makes
 * it keyword-searchable, so queries like "girl holding a coffee" find the photo.
 *
 * All the ML runs where Ollama runs; the Aurora box only stores/searches text.
 *
 * Resumable & stateless: the "pending" cursor lives on the server (assets.captioned_at),
 * so you can stop/restart this any time. A photo is only marked done once its caption
 * is ingested — if Ollama errors, that photo is simply retried on the next pass.
 *
 * Requirements: Node 18+ (built-in fetch), a running Ollama with a vision model pulled.
 *   ollama pull qwen2.5vl:3b      # light, good quality (default)
 *   ollama pull moondream         # lightest/fastest, lower quality
 *   ollama pull qwen2.5vl:7b      # higher quality, more RAM
 *
 * Run (defaults assume Aurora + Ollama are reachable on localhost):
 *   node caption-worker.js
 *   AURORA=http://aurora.local:8080 OLLAMA=http://ollama.local:11434 \
 *     MODEL=qwen2.5vl:3b BATCH=20 CONCURRENCY=1 node caption-worker.js
 */
'use strict';

const CFG = {
  AURORA:      process.env.AURORA      || 'http://localhost:8080',
  OLLAMA:      process.env.OLLAMA      || 'http://localhost:11434',
  // Keep the default light on RAM. Bump to qwen2.5vl:7b only if the box has headroom.
  MODEL:       process.env.MODEL       || 'qwen2.5vl:3b',
  BATCH:       parseInt(process.env.BATCH || '20', 10),       // photos pulled per request
  CONCURRENCY: parseInt(process.env.CONCURRENCY || '1', 10),  // simultaneous Ollama calls
  IDLE_MS:     parseInt(process.env.IDLE_MS || '60000', 10),  // sleep when nothing is pending
  ERROR_MS:    parseInt(process.env.ERROR_MS || '3000', 10),  // backoff after an error
  TIMEOUT_MS:  parseInt(process.env.TIMEOUT_MS || '120000', 10), // per-photo Ollama timeout
};

const PROMPT =
  'Describe this photo in 1-2 plain factual sentences for SEARCH. Name the main ' +
  'subjects, what they are doing, objects they hold or use, and the setting. Be ' +
  'literal and concise. Do not guess names or emotions. After the sentences, add a ' +
  'line starting with "Keywords:" listing 5-10 single search words separated by commas.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchImageBase64(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching image ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error(`empty image ${url}`);
    return buf.toString('base64');
  } finally {
    clearTimeout(t);
  }
}

async function captionOne({ id, image }) {
  const b64 = await fetchImageBase64(CFG.AURORA + image, CFG.TIMEOUT_MS);
  const out = await fetchJson(
    CFG.OLLAMA + '/api/generate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CFG.MODEL, prompt: PROMPT, images: [b64], stream: false }),
    },
    CFG.TIMEOUT_MS
  );
  const caption = (out && out.response ? String(out.response) : '').trim();
  if (!caption) throw new Error(`empty caption for asset ${id}`);
  await fetchJson(
    CFG.AURORA + '/api/aurora/captions/ingest',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: id, caption, model: CFG.MODEL }),
    },
    30000
  );
  return caption;
}

// Simple fixed-size worker pool over a list of assets.
async function processBatch(assets) {
  let i = 0, ok = 0, fail = 0;
  async function worker() {
    while (i < assets.length) {
      const a = assets[i++];
      try {
        const cap = await captionOne(a);
        ok++;
        console.log(`  [${a.id}] ${cap.replace(/\s+/g, ' ').slice(0, 90)}`);
      } catch (err) {
        fail++;
        console.warn(`  [${a.id}] skipped: ${err.message}`);
        await sleep(CFG.ERROR_MS); // brief backoff; photo retried next pass (still pending)
      }
    }
  }
  const n = Math.max(1, Math.min(CFG.CONCURRENCY, assets.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { ok, fail };
}

async function main() {
  console.log(`Aurora caption worker → AURORA=${CFG.AURORA} OLLAMA=${CFG.OLLAMA} MODEL=${CFG.MODEL} ` +
              `BATCH=${CFG.BATCH} CONCURRENCY=${CFG.CONCURRENCY}`);
  for (;;) {
    let pending;
    try {
      pending = await fetchJson(`${CFG.AURORA}/api/aurora/captions/pending?limit=${CFG.BATCH}`);
    } catch (err) {
      console.warn(`pending fetch failed: ${err.message} — retrying in ${CFG.ERROR_MS}ms`);
      await sleep(CFG.ERROR_MS);
      continue;
    }
    const assets = (pending && pending.assets) || [];
    if (!assets.length) {
      console.log(`nothing pending — sleeping ${Math.round(CFG.IDLE_MS / 1000)}s`);
      await sleep(CFG.IDLE_MS);
      continue;
    }
    console.log(`captioning ${assets.length} photo(s)…`);
    const t0 = Date.now();
    const { ok, fail } = await processBatch(assets);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`batch done: ${ok} ok, ${fail} failed in ${secs}s ` +
                `(${(ok / Math.max(0.001, (Date.now() - t0) / 1000)).toFixed(2)}/s)`);
  }
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
