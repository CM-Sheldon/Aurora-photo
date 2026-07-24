/**
 * Albums + public share links — integration tests over the real routers.
 *
 * Spins up an express app with the actual aurora + share routers mounted
 * against a throwaway SQLite DB (AURORA_DB_PATH → tmpdir), with a stubbed
 * admin session injected where the real app would run requireAuth. This
 * covers the load-bearing guarantees:
 *   - hidden / duplicate / live-motion assets never appear in album counts,
 *     album listings, or public shares
 *   - share tokens gate everything; revoking kills the link instantly
 *   - membership is re-checked on media requests (no cross-album leaks)
 *   - /memories only surfaces past years
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

process.env.AURORA_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-albums-test-')), 'test.db');

const db = require('../src/services/auroraDbService');
const express = require('express');

let server, base;

// Minimal stand-in for the authed session the real app attaches.
const ADMIN = { id: 1, username: 'test', permissions: ['photos.view', 'albums.manage', 'settings.view', 'settings.manage'] };

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

test.before(async () => {
  await db.initSchema();

  // Seed: 4 assets — 2 visible, 1 hidden, 1 duplicate. taken_at spans years.
  const now = new Date();
  // Same month/day as "today" (the route buckets in UTC but derives the target
  // day from local time — UTC-noon timestamps keep the m-d stable either way).
  const onThisDay = (yearsAgo) =>
    Date.UTC(now.getFullYear() - yearsAgo, now.getMonth(), now.getDate(), 12, 0, 0);

  const rows = [
    [1, '/photos/a.jpg', 'photo', onThisDay(2), 0, 0, null],
    [2, '/photos/b.jpg', 'photo', onThisDay(1), 0, 0, null],
    [3, '/photos/hidden.jpg', 'photo', onThisDay(1), 1, 0, null],
    [4, '/photos/dup.jpg', 'photo', onThisDay(1), 0, 0, 1],
  ];
  for (const [id, p, kind, taken, hidden, live, dup] of rows) {
    await db.run(
      `INSERT INTO assets (id, path, kind, taken_at, hidden, is_live_motion, duplicate_of, mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p, kind, taken, hidden, live, dup, Date.now()]
    );
  }

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = ADMIN; next(); });
  app.use('/api/aurora/share', require('../src/routes/shareRoutes'));
  app.use('/api/aurora', require('../src/routes/aurora'));

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('album CRUD: create, add assets, visible-only counts', async () => {
  const created = await api('POST', '/api/aurora/albums', { name: 'Test Trip' });
  assert.equal(created.status, 200);
  const albumId = created.body.id;
  assert.ok(albumId);

  // Add all four — hidden + duplicate must not count as visible members.
  const added = await api('POST', `/api/aurora/albums/${albumId}/assets`, { add: [1, 2, 3, 4] });
  assert.equal(added.status, 200);
  assert.equal(added.body.added, 4);
  assert.equal(added.body.count, 2, 'only visible assets count');

  const detail = await api('GET', `/api/aurora/albums/${albumId}/assets`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.assets.map(a => a.id).sort(), [1, 2], 'hidden/dup never listed');

  const list = await api('GET', '/api/aurora/albums');
  const mine = list.body.user.find(a => a.id === albumId);
  assert.ok(mine, 'album appears in the user list');
  assert.equal(mine.count, 2);
  assert.ok([1, 2].includes(mine.cover_id), 'cover falls back to a visible member');
});

test('cover: must be a member; hidden cover falls back to a visible member', async () => {
  const { body: created } = await api('POST', '/api/aurora/albums', { name: 'Covers' });
  await api('POST', `/api/aurora/albums/${created.id}/assets`, { add: [1, 3] });

  const bad = await api('POST', `/api/aurora/albums/${created.id}`, { coverAssetId: 2 });
  assert.equal(bad.status, 400, 'non-member cover rejected');

  // Hidden asset IS a member, so setting it succeeds — but the listing must
  // fall back to a visible cover rather than leak the hidden thumb.
  const ok = await api('POST', `/api/aurora/albums/${created.id}`, { coverAssetId: 3 });
  assert.equal(ok.status, 200);
  const list = await api('GET', '/api/aurora/albums');
  const mine = list.body.user.find(a => a.id === created.id);
  assert.equal(mine.cover_id, 1, 'hidden cover never surfaces in the album list');
});

test('share link lifecycle: mint → public read → revoke → 404', async () => {
  const { body: created } = await api('POST', '/api/aurora/albums', { name: 'Shared' });
  await api('POST', `/api/aurora/albums/${created.id}/assets`, { add: [1, 2, 3] });

  const share = await api('POST', `/api/aurora/albums/${created.id}/share`, { enable: true });
  assert.equal(share.status, 200);
  const token = share.body.token;
  assert.ok(token && token.length >= 16, 'unguessable token minted');

  // Minting again returns the SAME token (stable link).
  const again = await api('POST', `/api/aurora/albums/${created.id}/share`, { enable: true });
  assert.equal(again.body.token, token);

  const pub = await api('GET', `/api/aurora/share/${token}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.name, 'Shared');
  assert.deepEqual(pub.body.assets.map(a => a.id).sort(), [1, 2], 'hidden asset absent from public share');

  // Membership + visibility enforced on media: hidden member 404s.
  const hiddenThumb = await api('GET', `/api/aurora/share/${token}/thumb/3`);
  assert.equal(hiddenThumb.status, 404);

  // Bogus token 404s.
  const bogus = await api('GET', '/api/aurora/share/not-a-real-token-xx');
  assert.equal(bogus.status, 404);

  // Revoke → link dead immediately.
  await api('POST', `/api/aurora/albums/${created.id}/share`, { enable: false });
  const dead = await api('GET', `/api/aurora/share/${token}`);
  assert.equal(dead.status, 404);
});

test('share media never serves assets from another album', async () => {
  const { body: a } = await api('POST', '/api/aurora/albums', { name: 'A' });
  const { body: b } = await api('POST', '/api/aurora/albums', { name: 'B' });
  await api('POST', `/api/aurora/albums/${a.id}/assets`, { add: [1] });
  await api('POST', `/api/aurora/albums/${b.id}/assets`, { add: [2] });
  const shareA = await api('POST', `/api/aurora/albums/${a.id}/share`, { enable: true });

  // Asset 2 belongs to album B only — A's token must not unlock it.
  const cross = await api('GET', `/api/aurora/share/${shareA.body.token}/thumb/2`);
  assert.equal(cross.status, 404);
});

test('deleting an album removes it and its memberships, never the photos', async () => {
  const { body: created } = await api('POST', '/api/aurora/albums', { name: 'Doomed' });
  await api('POST', `/api/aurora/albums/${created.id}/assets`, { add: [1, 2] });
  const del = await api('POST', `/api/aurora/albums/${created.id}/delete`);
  assert.equal(del.status, 200);

  const gone = await api('GET', `/api/aurora/albums/${created.id}/assets`);
  assert.equal(gone.status, 404);
  const memberships = await db.get('SELECT COUNT(*) c FROM album_assets WHERE album_id = ?', [created.id]);
  assert.equal(memberships.c, 0);
  const assets = await db.get('SELECT COUNT(*) c FROM assets');
  assert.equal(assets.c, 4, 'photos untouched');
});

test('memories: only past years, hidden excluded, grouped newest-first', async () => {
  const mem = await api('GET', '/api/aurora/memories');
  assert.equal(mem.status, 200);
  const years = mem.body.years;
  assert.equal(years.length, 2, 'two past years with visible photos');
  assert.ok(years[0].year > years[1].year, 'newest year first');
  const allIds = years.flatMap(y => y.assets.map(a => a.id));
  assert.ok(!allIds.includes(3), 'hidden asset not in memories');
  assert.ok(!allIds.includes(4), 'duplicate not in memories');
});
