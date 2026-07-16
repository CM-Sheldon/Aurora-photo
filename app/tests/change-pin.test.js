/**
 * Change-PIN + must_change_pin tests.
 *
 * Covers the invariants the avatar-menu "Change PIN" flow and the forced
 * change-PIN dialog rely on:
 *   - admin resetUserPin sets must_change_pin AND kills all sessions
 *   - self-service changeOwnPin requires the current PIN
 *   - changeOwnPin clears must_change_pin
 *   - changeOwnPin keeps the caller's session but drops every other one
 *   - createUser defaults to must_change_pin=1 (admin flow) but can opt out
 *     (setup flow — first admin picks their own PIN)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP_DB = path.join(os.tmpdir(), `aurora-changepin-${process.pid}-${Date.now()}.db`);
process.env.AURORA_DB_PATH = TMP_DB;

const db = require('../src/services/auroraDbService');
const auth = require('../src/services/auroraAuthService');

test.before(async () => {
  await db.initSchema();
  await auth.ensureBuiltinRoles();
});
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (_) {}
  }
});

test('createUser defaults to must_change_pin=1 (admin-created accounts)', async () => {
  const id = await auth.createUser({ username: 'newbie', pin: '1234', roleName: 'user' });
  const u = await auth.getUserById(id);
  assert.equal(u.must_change_pin, 1);
  const verified = await auth.verifyPin('newbie', '1234');
  assert.equal(verified.mustChangePin, true);
});

test('createUser({mustChangePin:false}) skips the flag (setup flow)', async () => {
  const id = await auth.createUser({ username: 'firstadmin', pin: '2222', roleName: 'admin', mustChangePin: false });
  const u = await auth.getUserById(id);
  assert.equal(u.must_change_pin, 0);
  const verified = await auth.verifyPin('firstadmin', '2222');
  assert.equal(verified.mustChangePin, false);
});

test('admin resetUserPin sets must_change_pin and revokes every session', async () => {
  const id = await auth.createUser({ username: 'target', pin: '3333', roleName: 'user', mustChangePin: false });
  const tokenA = await auth.createSession(id, 'phone');
  const tokenB = await auth.createSession(id, 'laptop');
  assert.ok(await auth.getSession(tokenA));
  assert.ok(await auth.getSession(tokenB));

  await auth.resetUserPin(id, '4444');

  const u = await auth.getUserById(id);
  assert.equal(u.must_change_pin, 1);
  assert.equal(await auth.getSession(tokenA), null, 'reset should revoke old sessions');
  assert.equal(await auth.getSession(tokenB), null, 'reset should revoke every session');
  // The new PIN works for a fresh login.
  const verified = await auth.verifyPin('target', '4444');
  assert.equal(verified.username, 'target');
  assert.equal(verified.mustChangePin, true);
});

test('changeOwnPin requires the current PIN, clears the flag, keeps the caller session', async () => {
  const id = await auth.createUser({ username: 'selfchange', pin: '5555', roleName: 'user' });
  const my = await auth.createSession(id, 'this-device');
  const other = await auth.createSession(id, 'other-device');

  // Wrong current PIN → refused, nothing changes
  await assert.rejects(() => auth.changeOwnPin(id, '0000', '6666', my), /Current PIN is wrong/);
  const still = await auth.verifyPin('selfchange', '5555');
  assert.equal(still.username, 'selfchange');

  // Same new PIN as old → refused
  await assert.rejects(() => auth.changeOwnPin(id, '5555', '5555', my), /must be different/);

  // Bad format → validator throws
  await assert.rejects(() => auth.changeOwnPin(id, '5555', '12', my), /exactly 4 digits/);

  // Happy path
  await auth.changeOwnPin(id, '5555', '6666', my);
  const u = await auth.getUserById(id);
  assert.equal(u.must_change_pin, 0);
  assert.ok(await auth.getSession(my), 'caller session must survive');
  assert.equal(await auth.getSession(other), null, 'other devices must be signed out');

  // Old PIN no longer works; new one does
  await assert.rejects(() => auth.verifyPin('selfchange', '5555'), /Invalid/);
  const ok = await auth.verifyPin('selfchange', '6666');
  assert.equal(ok.mustChangePin, false);
});

test('changeOwnPin without a keep-token drops every session (defensive)', async () => {
  const id = await auth.createUser({ username: 'nokeep', pin: '7777', roleName: 'user' });
  const t1 = await auth.createSession(id, 'a');
  const t2 = await auth.createSession(id, 'b');
  await auth.changeOwnPin(id, '7777', '8888');
  assert.equal(await auth.getSession(t1), null);
  assert.equal(await auth.getSession(t2), null);
});
