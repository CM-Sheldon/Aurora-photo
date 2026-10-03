/**
 * Aurora 2 API additions — integration tests over the real router.
 *
 * Covers the endpoints the redesigned UI depends on:
 *   - /assets?order=added sorts newest-imported first
 *   - /assets?mode=or runs the OR form directly (paging fuzzy results)
 *   - /assets/index carries `d` (seconds) for videos only
 *   - cover_id on /places, /countries, /tags and the smart albums
 *     (never on the Hidden album)
 *   - POST /fav/bulk sets (not toggles) favourites and is permission-gated
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

process.env.AURORA_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-v2-test-')), 'test.db');

const db = require('../src/services/auroraDbService');
const express = require('express');

let server, base;
let currentUser = { userId: 1, username: 'admin', permissions: ['photos.view', 'photos.favorite', 'photos.hidden', 'albums.manage', 'settings.view'] };

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
  await db.run(`INSERT INTO places (id, name, country, lat, lon) VALUES (1, 'Paphos', 'Cyprus', 34.77, 32.42), (2, 'Poole', 'United Kingdom', 50.72, -1.98)`);
  //        id  path                kind     taken  indexed place dur  hidden fav
  const rows = [
    [1, '/p/a.jpg',   'photo', 1000,  5000, 1, null, 0, 0],
    [2, '/p/b.mov',   'video', 2000,  1000, 1, 12.6, 0, 0],
    [3, '/p/c.jpg',   'photo', 3000,  9000, 2, null, 0, 1],
    [4, '/p/hid.jpg', 'photo', 4000,  7000, 2, null, 1, 0],
    [5, '/p/beach.jpg', 'photo', 500, 2000, 1, null, 0, 0],
  ];
  for (const [id, p, kind, taken, indexed, place, dur, hidden, fav] of rows) {
    await db.run(
      `INSERT INTO assets (id, path, kind, taken_at, indexed_at, place_id, duration_s, hidden, fav, mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p, kind, taken, indexed, place, dur, hidden, fav, Date.now()]
    );
  }
  await db.run(`INSERT INTO tags (id, name) VALUES (1, 'Holiday')`);
  await db.run(`INSERT INTO asset_tags (asset_id, tag_id, created_at) VALUES (1, 1, 0), (2, 1, 0)`);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/aurora', require('../src/routes/aurora'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('/assets default order is newest captured first', async () => {
  const r = await api('GET', '/api/aurora/assets?limit=10');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.assets.map(a => a.id), [3, 2, 1, 5]);   // hidden #4 excluded
});

test('/assets?order=added is newest imported first', async () => {
  const r = await api('GET', '/api/aurora/assets?order=added&limit=10&count=1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.assets.map(a => a.id), [3, 1, 5, 2]);
  assert.equal(r.body.total, 4);
});

test('/assets?mode=or matches either word straight away (for paging)', async () => {
  const and = await api('GET', '/api/aurora/assets?q=beach%20paphosxyz&strict=1');
  assert.equal(and.body.assets.length, 0);
  const or = await api('GET', '/api/aurora/assets?q=beach%20paphosxyz&mode=or&offset=0');
  assert.ok(or.body.assets.some(a => a.id === 5), 'OR form should match "beach"');
  assert.equal(or.body.fuzzy, true);
});

test('/assets/index carries d for videos only', async () => {
  const r = await api('GET', '/api/aurora/assets/index');
  const vid = r.body.find(x => x.id === 2), photo = r.body.find(x => x.id === 1);
  assert.equal(vid.d, 13);
  assert.ok(!('d' in photo), 'photos must not carry a d key');
  assert.ok(!r.body.some(x => x.id === 4), 'hidden assets stay out of the index');
});

test('cover photos on places, countries and tags prefer photos', async () => {
  const places = (await api('GET', '/api/aurora/places')).body;
  const paphos = places.find(p => p.id === 1);
  assert.ok([1, 5].includes(paphos.cover_id), 'cover should be a photo, not the video');
  const countries = (await api('GET', '/api/aurora/countries')).body;
  assert.ok(countries.find(c => c.country === 'Cyprus').cover_id);
  const tags = (await api('GET', '/api/aurora/tags')).body;
  assert.equal(tags.find(t => t.id === 1).cover_id, 1);
});

test('smart albums: covers + Recently added; Hidden never leaks a cover', async () => {
  const r = await api('GET', '/api/aurora/albums');
  const by = Object.fromEntries(r.body.smart.map(s => [s.id, s]));
  assert.equal(by.favorites.cover_id, 3);
  assert.equal(by.videos.cover_id, 2);
  assert.equal(by.added.cover_id, 3);
  assert.equal(by.added.query.order, 'added');
  assert.ok(by.hidden, 'hidden album listed for photos.hidden');
  assert.equal(by.hidden.cover_id, undefined);
});

test('POST /fav/bulk sets favourites (idempotent, not a toggle)', async () => {
  let r = await api('POST', '/api/aurora/fav/bulk', { assetIds: [1, 3], fav: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, 1);                 // #3 was already a favourite
  r = await api('POST', '/api/aurora/fav/bulk', { assetIds: [1, 3], fav: 1 });
  assert.equal(r.body.changed, 0);
  const favs = (await api('GET', '/api/aurora/assets?fav=1')).body.assets.map(a => a.id).sort();
  assert.deepEqual(favs, [1, 3]);
  r = await api('POST', '/api/aurora/fav/bulk', { assetIds: [1, 3], fav: 0 });
  assert.equal(r.body.changed, 2);
  // /fav/:id must still toggle for single items.
  r = await api('POST', '/api/aurora/fav/3', {});
  assert.equal(r.body.fav, 1);
});

test('POST /fav/bulk needs photos.favorite', async () => {
  const saved = currentUser;
  currentUser = { userId: 2, username: 'viewer', permissions: ['photos.view'] };
  try {
    const r = await api('POST', '/api/aurora/fav/bulk', { assetIds: [1], fav: 1 });
    assert.equal(r.status, 403);
  } finally { currentUser = saved; }
});
