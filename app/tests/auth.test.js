/**
 * Auth service tests. Points auroraDbService at a temp DB via AURORA_DB_PATH,
 * initialises the schema, and covers:
 *   - PIN hashing/verify round-trip
 *   - Failed-attempt lockout
 *   - Built-in role catalogue matches PERMISSIONS
 *   - Custom role permissions are validated + persisted
 *   - Session create → get → delete lifecycle
 *
 * These are the guarantees the /login page + RBAC middleware rely on. If
 * hashPin ever changes salt strategy or verifyPin drifts, this suite fails
 * before anyone hits it in production.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP_DB = path.join(os.tmpdir(), `aurora-auth-${process.pid}-${Date.now()}.db`);
process.env.AURORA_DB_PATH = TMP_DB;

const db = require('../src/services/auroraDbService');
const auth = require('../src/services/auroraAuthService');

test.before(async () => {
  await db.initSchema();
  await auth.ensureBuiltinRoles();
});

test.after(() => {
  try { fs.unlinkSync(TMP_DB); } catch (_) {}
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch (_) {}
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch (_) {}
});

test('PERMISSIONS catalogue is non-empty and every key is unique', () => {
  assert.ok(auth.PERMISSIONS.length >= 6);
  const seen = new Set();
  for (const p of auth.PERMISSIONS) {
    assert.ok(p.key && p.group && p.label, `missing fields on ${JSON.stringify(p)}`);
    assert.ok(!seen.has(p.key), `duplicate permission key: ${p.key}`);
    seen.add(p.key);
  }
  assert.deepEqual(auth.ALL_PERMS, auth.PERMISSIONS.map(p => p.key));
});

test('built-in admin role has EVERY permission', async () => {
  const roles = await auth.listRoles();
  const admin = roles.find(r => r.name === 'admin');
  assert.ok(admin, 'admin role should be seeded');
  for (const key of auth.ALL_PERMS) {
    assert.ok(admin.permissions.includes(key), `admin missing ${key}`);
  }
});

test('built-in user role is narrow (view + favorite only)', async () => {
  const roles = await auth.listRoles();
  const user = roles.find(r => r.name === 'user');
  assert.ok(user);
  // Deliberately narrow — see project memory / RBAC design.
  assert.deepEqual(user.permissions.sort(), ['photos.favorite', 'photos.view'].sort());
});

test('createUser + verifyPin round-trip returns the role permissions', async () => {
  const id = await auth.createUser({ username: 'alice', pin: '1234', roleName: 'user' });
  assert.ok(id > 0);

  const ok = await auth.verifyPin('alice', '1234');
  assert.equal(ok.username, 'alice');
  assert.equal(ok.role, 'user');
  assert.ok(ok.permissions.includes('photos.view'));
  assert.ok(!ok.permissions.includes('photos.tag'), 'user must not have tag perm');
});

test('verifyPin with wrong PIN throws and (after 5 tries) locks the account', async () => {
  await auth.createUser({ username: 'bob', pin: '4321', roleName: 'user' });
  // 4 wrong attempts — should throw but NOT lock yet.
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => auth.verifyPin('bob', '0000'), /Invalid/);
  }
  // 5th attempt trips the lock.
  await assert.rejects(() => auth.verifyPin('bob', '0000'), /Invalid/);
  // Even the correct PIN now bounces off the lock window.
  await assert.rejects(() => auth.verifyPin('bob', '4321'), /Too many wrong PINs/);
});

test('validatePin rejects non-4-digit input', () => {
  assert.throws(() => auth.validatePin('12'), /exactly 4 digits/);
  assert.throws(() => auth.validatePin('12345'), /exactly 4 digits/);
  assert.throws(() => auth.validatePin('abcd'), /exactly 4 digits/);
  assert.equal(auth.validatePin('9999'), '9999');
});

test('validateUsername enforces the character set', () => {
  assert.throws(() => auth.validateUsername('a'), /2–32/);
  assert.throws(() => auth.validateUsername('has space'), /2–32/);
  assert.throws(() => auth.validateUsername('has$sign'), /2–32/);
  assert.equal(auth.validateUsername('good-one_2'), 'good-one_2');
});

test('createRole rejects unknown permission keys', async () => {
  await assert.rejects(
    () => auth.createRole({ name: 'bogus', permissions: ['photos.view', 'not.a.thing'] }),
    /Unknown permission/);
});

test('createRole persists a custom role with a subset of permissions', async () => {
  const id = await auth.createRole({ name: 'viewer-only', permissions: ['photos.view'] });
  assert.ok(id > 0);
  const roles = await auth.listRoles();
  const r = roles.find(x => x.name === 'viewer-only');
  assert.ok(r);
  assert.deepEqual(r.permissions, ['photos.view']);
});

test('the admin role cannot be edited', async () => {
  const roles = await auth.listRoles();
  const admin = roles.find(r => r.name === 'admin');
  await assert.rejects(
    () => auth.updateRole(admin.id, { permissions: ['photos.view'] }),
    /admin role/);
});

test('cannot demote or delete the last admin', async () => {
  const adminId = await auth.createUser({ username: 'root', pin: '9999', roleName: 'admin' });
  // Only one admin left — demoting to `user` must throw.
  await assert.rejects(() => auth.setUserRole(adminId, 'user'), /last admin/);
  await assert.rejects(() => auth.setUserDisabled(adminId, true), /last admin/);
  await assert.rejects(() => auth.deleteUser(adminId), /last admin/);
});

test('session lifecycle: create → get → delete', async () => {
  const uid = await auth.createUser({ username: 'sess-user', pin: '5678', roleName: 'user' });
  const token = await auth.createSession(uid, 'test-agent');
  assert.ok(token && token.length >= 32);

  const s = await auth.getSession(token);
  assert.equal(s.username, 'sess-user');
  assert.equal(s.role, 'user');

  await auth.deleteSession(token);
  const gone = await auth.getSession(token);
  assert.equal(gone, null);
});
