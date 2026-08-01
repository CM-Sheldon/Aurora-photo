/**
 * Sprint v1.9 — integration + unit tests for the new features:
 *   - soft-remove lifecycle (removed hidden everywhere, kept for anti-reimport,
 *     restorable) and the /assets/removed listing
 *   - Places map timeline filter (/places?from&to)
 *   - video rotation column surfaced in asset payloads
 *   - usage audit logging (favorite / remove write audit rows)
 *   - user profile (rename + avatar) and per-account theme prefs
 *
 * Mirrors albums-share.test.js: a throwaway SQLite DB + the real routers with a
 * stubbed admin session injected where the app would run requireAuth.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

process.env.AURORA_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-sprint19-')), 'test.db');

const db = require('../src/services/auroraDbService');
const auth = require('../src/services/auroraAuthService');
const express = require('express');

let server, base;

const ADMIN = {
  userId: 1, id: 1, username: 'admin',
  permissions: ['photos.view', 'photos.favorite', 'photos.tag', 'photos.delete',
                'photos.hidden', 'albums.manage', 'settings.view', 'settings.manage'],
};

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

const YEAR = 365 * 24 * 3600 * 1000;

test.before(async () => {
  await db.initSchema();

  // Two places, assets spanning 2021 / 2023, one video with rotation, one hidden.
  await db.run(`INSERT INTO places (id, name, country, lat, lon) VALUES (1,'Paris','France',48.85,2.35)`);
  await db.run(`INSERT INTO places (id, name, country, lat, lon) VALUES (2,'Tokyo','Japan',35.68,139.69)`);

  const t2021 = Date.UTC(2021, 5, 1, 12);
  const t2023 = Date.UTC(2023, 5, 1, 12);
  const rows = [
    // id, path, kind, taken_at, place_id, rotation, hidden, gps_lat, gps_lon
    [1, '/p/paris1.jpg', 'photo', t2021, 1, 0, 0, 48.85, 2.35],
    [2, '/p/paris2.jpg', 'photo', t2023, 1, 0, 0, 48.85, 2.35],
    [3, '/p/tokyo1.jpg', 'photo', t2023, 2, 0, 0, 35.68, 139.69],
    [4, '/p/portrait.mov', 'video', t2023, 2, 90, 0, 35.68, 139.69],
    [5, '/p/secret.jpg', 'photo', t2023, 1, 0, 1, 48.85, 2.35],
  ];
  for (const [id, p, kind, taken, place, rot, hidden, lat, lon] of rows) {
    await db.run(
      `INSERT INTO assets (id, path, kind, taken_at, place_id, rotation, hidden, gps_lat, gps_lon, mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p, kind, taken, place, rot, hidden, lat, lon, Date.now()]
    );
  }

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = ADMIN; next(); });
  app.use('/api/aurora', require('../src/routes/aurora'));

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

// ── Soft-remove ────────────────────────────────────────────────────────────
test('remove: takes an asset out of every view but keeps the row', async () => {
  // Baseline: 3 visible photos + 1 visible video (5 is hidden).
  const before = await api('GET', '/api/aurora/assets/index');
  assert.equal(before.body.length, 4, 'index shows the 4 non-hidden assets');

  const rm = await api('POST', '/api/aurora/assets/remove', { assetIds: [1] });
  assert.equal(rm.status, 200);
  assert.equal(rm.body.count, 1);

  const idx = await api('GET', '/api/aurora/assets/index');
  assert.ok(!idx.body.some(a => a.id === 1), 'removed asset gone from index');

  const grid = await api('GET', '/api/aurora/assets');
  assert.ok(!grid.body.assets.some(a => a.id === 1), 'removed asset gone from grid');

  const stats = await api('GET', '/api/aurora/stats');
  assert.equal(stats.body.photos, 2, 'stats drops the removed photo (paris2 + tokyo1 left)');

  // The DB row survives (that is what blocks re-import) — just flagged removed.
  const row = await db.get('SELECT removed, removed_at FROM assets WHERE id = 1');
  assert.equal(row.removed, 1);
  assert.ok(row.removed_at > 0, 'removed_at stamped');
});

test('removed: listing shows path + name; restore brings it back', async () => {
  const list = await api('GET', '/api/aurora/assets/removed');
  assert.equal(list.status, 200);
  const one = list.body.removed.find(r => r.id === 1);
  assert.ok(one, 'removed asset is listed');
  assert.equal(one.filename, 'paris1.jpg');
  assert.equal(one.path, '/p/paris1.jpg');

  const restore = await api('POST', '/api/aurora/assets/restore', { assetIds: [1] });
  assert.equal(restore.status, 200);
  const idx = await api('GET', '/api/aurora/assets/index');
  assert.ok(idx.body.some(a => a.id === 1), 'restored asset back in the library');
  const still = await api('GET', '/api/aurora/assets/removed');
  assert.ok(!still.body.removed.some(r => r.id === 1), 'no longer in removed list');
});

test('remove: hidden from places counts and requires ids', async () => {
  const bad = await api('POST', '/api/aurora/assets/remove', { assetIds: [] });
  assert.equal(bad.status, 400);

  await api('POST', '/api/aurora/assets/remove', { assetIds: [3] });   // remove tokyo1
  const places = await api('GET', '/api/aurora/places');
  const tokyo = places.body.find(p => p.id === 2);
  // Tokyo had tokyo1 (photo) + portrait video; removing the photo leaves the video.
  assert.equal(tokyo.count, 1, 'place count reflects the removal');
  await api('POST', '/api/aurora/assets/restore', { assetIds: [3] });
});

// ── Places timeline filter ───────────────────────────────────────────────────
test('places: from/to narrows which places appear', async () => {
  const all = await api('GET', '/api/aurora/places');
  assert.equal(all.body.length, 2, 'both places at full range');

  // Only 2021 → just Paris (paris1).
  const from = Date.UTC(2021, 0, 1), to = Date.UTC(2022, 0, 1);
  const y2021 = await api('GET', `/api/aurora/places?from=${from}&to=${to}`);
  assert.equal(y2021.body.length, 1, 'only one place has photos in 2021');
  assert.equal(y2021.body[0].name, 'Paris');
  assert.equal(y2021.body[0].count, 1);

  // A window with nothing in it → no places.
  const empty = await api('GET', `/api/aurora/places?from=${Date.UTC(2010,0,1)}&to=${Date.UTC(2011,0,1)}`);
  assert.equal(empty.body.length, 0);
});

test('places: pin gallery query (place + from/to) honours the window', async () => {
  // Paris has paris1 (2021) + paris2 (2023). A 2021-only window must return
  // only paris1 — this is the "filtered map still opened 2024 photos" bug.
  const from = Date.UTC(2021, 0, 1), to = Date.UTC(2022, 0, 1);
  const r = await api('GET', `/api/aurora/assets?place=1&from=${from}&to=${to}&count=1`);
  assert.equal(r.body.total, 1);
  assert.deepEqual(r.body.assets.map(a => a.id), [1], 'only the in-window photo');
});

// ── Video rotation surfaced ──────────────────────────────────────────────────
test('rotation: exposed in the asset list and detail payloads', async () => {
  const grid = await api('GET', '/api/aurora/assets');
  const vid = grid.body.assets.find(a => a.id === 4);
  assert.ok(vid, 'video present');
  assert.equal(vid.rotation, 90, 'rotation carried in the list payload');

  const detail = await api('GET', '/api/aurora/asset/4');
  assert.equal(detail.body.rotation, 90, 'rotation in the detail payload');
});

// ── Usage audit ──────────────────────────────────────────────────────────────
test('audit: usage actions (favorite, remove) write audit rows', async () => {
  const before = (await db.get('SELECT COUNT(*) c FROM audit_log')).c;
  await api('POST', '/api/aurora/fav/2');
  await api('POST', '/api/aurora/assets/remove', { assetIds: [2] });
  await api('POST', '/api/aurora/assets/restore', { assetIds: [2] });
  const rows = await db.all('SELECT action FROM audit_log ORDER BY id DESC LIMIT 5');
  const actions = rows.map(r => r.action);
  assert.ok(actions.includes('photo.favorite'), 'favorite logged');
  assert.ok(actions.includes('photo.remove'), 'remove logged');
  assert.ok(actions.includes('photo.restore'), 'restore logged');
  assert.ok((await db.get('SELECT COUNT(*) c FROM audit_log')).c > before);
});

// ── User profile + theme (auth service unit) ─────────────────────────────────
test('auth: rename + avatar + theme round-trip via the session', async () => {
  await auth.ensureBuiltinRoles();
  const id = await auth.createUser({ username: 'alice', pin: '1234', roleName: 'user', mustChangePin: false });

  await auth.updateUserProfile(id, { username: 'alice2', avatar: '🦊' });
  const u = await auth.getUserById(id);
  assert.equal(u.username, 'alice2');
  assert.equal(u.avatar, '🦊');

  await auth.setOwnPrefs(id, { theme: 'dark' });
  const token = await auth.createSession(id, 'test-agent');
  const sess = await auth.getSession(token);
  assert.equal(sess.theme, 'dark', 'theme surfaces on the session (→ /me)');
  assert.equal(sess.avatar, '🦊');
});

test('rotation: normalizeRotation snaps to the four right angles', () => {
  const { normalizeRotation } = require('../src/services/auroraIndexerService');
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation('270'), 270);
  assert.equal(normalizeRotation('Rotate 90 CW'), 90);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(45), 0);      // not a right angle → ignored
  assert.equal(normalizeRotation(360), 0);
  assert.equal(normalizeRotation(null), 0);
  assert.equal(normalizeRotation(undefined), 0);
});

test('auth: profile validation — bad theme, oversized avatar, name clash', async () => {
  const id = await auth.createUser({ username: 'bob', pin: '1234', roleName: 'user', mustChangePin: false });
  await assert.rejects(() => auth.setOwnPrefs(id, { theme: 'neon' }), /theme/i);
  await assert.rejects(() => auth.setOwnPrefs(id, { avatar: 'aaaaa' }), /icon/i);
  // 'alice2' already exists from the previous test.
  await assert.rejects(() => auth.updateUserProfile(id, { username: 'alice2' }), /taken/i);
});
