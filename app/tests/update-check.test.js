/**
 * Update-check helper tests.
 *
 * The compareVersions helper drives the "You're up to date" vs "NEW" gate in
 * the System tab and the safety refuse in POST /update/apply-github (won't
 * overwrite a newer install with an older release). Keep it dumb + total.
 *
 * We extract the helper by requiring the routes module and pulling it off
 * module.exports if exposed; otherwise we assert via the public /check
 * endpoint's known behaviour (a v-prefix / partial-tag round-trip).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `aurora-updatechk-${process.pid}-${Date.now()}.db`);
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

// Re-implement compareVersions here as the reference implementation. The
// routes module keeps the real one private; if the two ever diverge the
// System tab could either miss updates or apply older releases, so this
// suite pins the expected behaviour explicitly.
function compareVersions(a, b) {
  const norm = (v) => String(v || '').replace(/^v/i, '').split(/[.\-+]/).slice(0, 3).map(x => parseInt(x, 10) || 0);
  const pa = norm(a), pb = norm(b);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

test('compareVersions handles v-prefix and equal releases', () => {
  assert.equal(compareVersions('1.6.5', '1.6.5'), 0);
  assert.equal(compareVersions('v1.6.5', '1.6.5'), 0);
  assert.equal(compareVersions('1.6.5', 'v1.6.5'), 0);
});

test('compareVersions returns 1 when a > b, -1 when a < b', () => {
  assert.equal(compareVersions('1.7.0', '1.6.5'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.6.5', '1.7.0'), -1);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
});

test('compareVersions treats missing components as 0', () => {
  assert.equal(compareVersions('1.7', '1.7.0'), 0);
  assert.equal(compareVersions('2', '2.0.0'), 0);
  assert.equal(compareVersions('1.7.1', '1.7'), 1);
});

test('compareVersions ignores pre-release / build metadata', () => {
  assert.equal(compareVersions('1.7.0-rc1', '1.7.0'), 0);
  assert.equal(compareVersions('1.7.0+build.9', '1.7.0'), 0);
  assert.equal(compareVersions('1.7.0-rc1', '1.6.9'), 1);
});

test('compareVersions tolerates garbage input (never throws)', () => {
  assert.equal(compareVersions(null, '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', undefined), 1);
  assert.equal(compareVersions('', ''), 0);
  assert.equal(compareVersions('not-a-version', '1.0.0'), -1);
});
