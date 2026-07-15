/**
 * Aurora auth service — users, roles, PIN hashing, sessions, audit.
 *
 * PIN is short by design (4 digits). Brute-force protection is layered:
 *   - scrypt with per-user salt (slow to hash, so throughput is bounded)
 *   - failed_attempts counter + locked_until timestamp on the user row
 *
 * Sessions are opaque random tokens stored in a cookie; the row in `sessions`
 * is the source of truth so an admin PIN reset can invalidate every device
 * for that user in one DELETE.
 */
const crypto = require('crypto');
const db = require('./auroraDbService');

// ── Permission catalog ────────────────────────────────────────────────────
// One list, referenced everywhere. Grouped for the admin UI checkbox tree.
const PERMISSIONS = [
  { key: 'photos.view',      group: 'Photos',   label: 'View library (browse, map, search)' },
  { key: 'photos.favorite',  group: 'Photos',   label: 'Mark favorites' },
  { key: 'photos.tag',       group: 'Photos',   label: 'Add / remove tags' },
  { key: 'photos.download',  group: 'Photos',   label: 'Download originals + zip shares' },
  { key: 'photos.hidden',    group: 'Photos',   label: 'See and manage the hidden album' },
  { key: 'photos.delete',    group: 'Photos',   label: 'Delete / resolve duplicates' },
  { key: 'settings.view',    group: 'Settings', label: 'View settings / metrics' },
  { key: 'settings.manage',  group: 'Settings', label: 'Change settings (imports, mounts, warming, updates)' },
  { key: 'users.manage',     group: 'Admin',    label: 'Manage users' },
  { key: 'roles.manage',     group: 'Admin',    label: 'Manage roles' },
  { key: 'audit.view',       group: 'Admin',    label: 'View audit log' },
];
const ALL_PERMS = PERMISSIONS.map(p => p.key);

// Built-in role: admin gets everything. Cannot be edited, renamed, or deleted.
const ADMIN_ROLE = { name: 'admin', permissions: ALL_PERMS };
// Built-in role: user gets only read-access. Editable by admin, can't be deleted.
// Kept intentionally narrow per the RBAC design conversation (see project memory).
const USER_ROLE  = { name: 'user',  permissions: ['photos.view', 'photos.favorite'] };

const SESSION_COOKIE = 'aurora_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days rolling
const LOGIN_LOCK_ATTEMPTS = 5;
const LOGIN_LOCK_MS       = 15 * 60 * 1000;

// ── Hashing ───────────────────────────────────────────────────────────────
function hashPin(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, 64, { N: 16384, r: 8, p: 1 }, (err, buf) => {
      if (err) reject(err); else resolve(buf.toString('hex'));
    });
  });
}
function randSalt() { return crypto.randomBytes(16).toString('hex'); }
function randToken() { return crypto.randomBytes(32).toString('hex'); }

// Timing-safe hex compare so an early-return doesn't leak PIN length info.
function safeEq(a, b) {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── Bootstrap: make sure the two built-in roles exist ─────────────────────
// Admin's permissions are refreshed on every boot so adding a new permission
// key to PERMISSIONS above automatically grants it to admin without a
// migration. User's permissions are left alone once seeded — admins may have
// customised them.
async function ensureBuiltinRoles() {
  const now = Date.now();
  const admin = await db.get(`SELECT id, permissions FROM roles WHERE name = ?`, [ADMIN_ROLE.name]);
  if (!admin) {
    await db.run(`INSERT INTO roles (name, is_builtin, permissions, created_at) VALUES (?, 1, ?, ?)`,
      [ADMIN_ROLE.name, JSON.stringify(ADMIN_ROLE.permissions), now]);
  } else {
    await db.run(`UPDATE roles SET permissions = ? WHERE id = ?`,
      [JSON.stringify(ADMIN_ROLE.permissions), admin.id]);
  }
  const user = await db.get(`SELECT id FROM roles WHERE name = ?`, [USER_ROLE.name]);
  if (!user) {
    await db.run(`INSERT INTO roles (name, is_builtin, permissions, created_at) VALUES (?, 1, ?, ?)`,
      [USER_ROLE.name, JSON.stringify(USER_ROLE.permissions), now]);
  }
}

async function countAdmins() {
  const row = await db.get(`
    SELECT COUNT(*) AS c FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = ? AND u.disabled = 0`, [ADMIN_ROLE.name]);
  return row ? row.c : 0;
}
async function needsSetup() { return (await countAdmins()) === 0; }

// ── User CRUD ─────────────────────────────────────────────────────────────
function validateUsername(name) {
  const s = String(name || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(s)) throw new Error('Username must be 2–32 chars: letters, numbers, _.-');
  return s;
}
function validatePin(pin) {
  const s = String(pin || '');
  if (!/^\d{4}$/.test(s)) throw new Error('PIN must be exactly 4 digits');
  return s;
}

async function createUser({ username, pin, roleName }) {
  username = validateUsername(username);
  pin = validatePin(pin);
  const role = await db.get(`SELECT id FROM roles WHERE name = ?`, [roleName]);
  if (!role) throw new Error(`Unknown role: ${roleName}`);
  const salt = randSalt();
  const hash = await hashPin(pin, salt);
  const now = Date.now();
  const r = await db.run(
    `INSERT INTO users (username, pin_hash, pin_salt, role_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    [username, hash, salt, role.id, now]);
  return r.lastID;
}

async function getUserById(id) {
  return db.get(`
    SELECT u.id, u.username, u.disabled, u.created_at, u.last_seen_at,
           u.locked_until, u.failed_attempts, r.id AS role_id, r.name AS role_name, r.permissions
    FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [id]);
}
async function getUserByName(name) {
  return db.get(`
    SELECT u.id, u.username, u.pin_hash, u.pin_salt, u.disabled,
           u.locked_until, u.failed_attempts, r.id AS role_id, r.name AS role_name, r.permissions
    FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = ?`, [name]);
}
async function listUsers() {
  return db.all(`
    SELECT u.id, u.username, u.disabled, u.created_at, u.last_seen_at, u.locked_until,
           r.name AS role_name
    FROM users u JOIN roles r ON r.id = u.role_id
    ORDER BY u.username COLLATE NOCASE`);
}

// Ensures we never demote the last admin — the app would become unmanageable.
async function assertNotLastAdmin(userId) {
  const u = await getUserById(userId);
  if (!u || u.role_name !== ADMIN_ROLE.name) return;
  const admins = await countAdmins();
  if (admins <= 1) throw new Error('Cannot remove or demote the last admin');
}

async function setUserRole(userId, roleName) {
  const role = await db.get(`SELECT id, name FROM roles WHERE name = ?`, [roleName]);
  if (!role) throw new Error(`Unknown role: ${roleName}`);
  if (role.name !== ADMIN_ROLE.name) await assertNotLastAdmin(userId);
  await db.run(`UPDATE users SET role_id = ? WHERE id = ?`, [role.id, userId]);
}
async function setUserDisabled(userId, disabled) {
  if (disabled) await assertNotLastAdmin(userId);
  await db.run(`UPDATE users SET disabled = ? WHERE id = ?`, [disabled ? 1 : 0, userId]);
  if (disabled) await deleteSessionsForUser(userId);
}
async function resetUserPin(userId, newPin) {
  newPin = validatePin(newPin);
  const salt = randSalt();
  const hash = await hashPin(newPin, salt);
  await db.run(
    `UPDATE users SET pin_hash = ?, pin_salt = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?`,
    [hash, salt, userId]);
  await deleteSessionsForUser(userId);
}
async function deleteUser(userId) {
  await assertNotLastAdmin(userId);
  await db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
  await db.run(`DELETE FROM users WHERE id = ?`, [userId]);
}

// ── Role CRUD ─────────────────────────────────────────────────────────────
function validateRoleName(name) {
  const s = String(name || '').trim();
  if (!/^[a-zA-Z0-9_ -]{2,32}$/.test(s)) throw new Error('Role name must be 2–32 chars');
  return s;
}
function validatePermissions(perms) {
  if (!Array.isArray(perms)) throw new Error('permissions must be an array');
  const bad = perms.find(p => !ALL_PERMS.includes(p));
  if (bad) throw new Error(`Unknown permission: ${bad}`);
  return [...new Set(perms)];
}
async function listRoles() {
  const rows = await db.all(`SELECT id, name, is_builtin, permissions, created_at FROM roles ORDER BY is_builtin DESC, name`);
  return rows.map(r => ({ ...r, permissions: JSON.parse(r.permissions || '[]') }));
}
async function createRole({ name, permissions }) {
  name = validateRoleName(name);
  permissions = validatePermissions(permissions);
  const r = await db.run(`INSERT INTO roles (name, is_builtin, permissions, created_at) VALUES (?, 0, ?, ?)`,
    [name, JSON.stringify(permissions), Date.now()]);
  return r.lastID;
}
async function updateRole(id, { permissions, name }) {
  const role = await db.get(`SELECT id, name, is_builtin FROM roles WHERE id = ?`, [id]);
  if (!role) throw new Error('Role not found');
  if (role.is_builtin && role.name === ADMIN_ROLE.name) {
    throw new Error("The admin role's permissions can't be edited");
  }
  const sets = [], params = [];
  if (permissions !== undefined) {
    sets.push('permissions = ?'); params.push(JSON.stringify(validatePermissions(permissions)));
  }
  if (name !== undefined) {
    if (role.is_builtin) throw new Error("Built-in roles can't be renamed");
    sets.push('name = ?'); params.push(validateRoleName(name));
  }
  if (!sets.length) return;
  params.push(id);
  await db.run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, params);
}
async function deleteRole(id) {
  const role = await db.get(`SELECT id, name, is_builtin FROM roles WHERE id = ?`, [id]);
  if (!role) throw new Error('Role not found');
  if (role.is_builtin) throw new Error("Built-in roles can't be deleted");
  const inUse = await db.get(`SELECT COUNT(*) AS c FROM users WHERE role_id = ?`, [id]);
  if (inUse && inUse.c) throw new Error(`Role in use by ${inUse.c} user(s) — reassign first`);
  await db.run(`DELETE FROM roles WHERE id = ?`, [id]);
}

// ── Sessions ──────────────────────────────────────────────────────────────
async function createSession(userId, userAgent) {
  const token = randToken();
  const now = Date.now();
  await db.run(`INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`,
    [token, userId, now, now + SESSION_TTL_MS, (userAgent || '').slice(0, 200)]);
  return token;
}
async function getSession(token) {
  if (!token) return null;
  const row = await db.get(`
    SELECT s.token, s.user_id, s.expires_at,
           u.username, u.disabled, r.name AS role_name, r.permissions
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN roles r ON r.id = u.role_id
    WHERE s.token = ?`, [token]);
  if (!row) return null;
  if (row.expires_at < Date.now() || row.disabled) {
    await db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
    return null;
  }
  return {
    token: row.token,
    userId: row.user_id,
    username: row.username,
    role: row.role_name,
    permissions: JSON.parse(row.permissions || '[]'),
  };
}
async function touchSession(token) {
  // Rolling expiry — bump expires_at on each authed request so an active user
  // never gets logged out mid-session, but an idle device eventually does.
  await db.run(`UPDATE sessions SET expires_at = ? WHERE token = ?`,
    [Date.now() + SESSION_TTL_MS, token]);
}
async function deleteSession(token) { await db.run(`DELETE FROM sessions WHERE token = ?`, [token]); }
async function deleteSessionsForUser(userId) { await db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]); }
async function pruneExpiredSessions() { await db.run(`DELETE FROM sessions WHERE expires_at < ?`, [Date.now()]); }

// ── Login ─────────────────────────────────────────────────────────────────
// Returns { userId, username, role, permissions } on success, or throws with
// a message safe to show the client. The user row is locked for a window
// after too many wrong PINs — separate from the scrypt slowdown so someone
// hammering one account gets stopped in seconds, not hours.
async function verifyPin(username, pin) {
  const now = Date.now();
  const u = await getUserByName(username);
  if (!u || u.disabled) {
    // Fake a hash to keep timing similar whether or not the user exists.
    await hashPin(pin, 'decoy-salt');
    throw new Error('Invalid username or PIN');
  }
  if (u.locked_until && u.locked_until > now) {
    const mins = Math.ceil((u.locked_until - now) / 60000);
    throw new Error(`Too many wrong PINs — try again in ${mins} min`);
  }
  const attempt = await hashPin(pin, u.pin_salt);
  if (!safeEq(attempt, u.pin_hash)) {
    const attempts = (u.failed_attempts || 0) + 1;
    const lockUntil = attempts >= LOGIN_LOCK_ATTEMPTS ? now + LOGIN_LOCK_MS : 0;
    await db.run(`UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?`,
      [lockUntil ? 0 : attempts, lockUntil, u.id]);
    throw new Error('Invalid username or PIN');
  }
  await db.run(`UPDATE users SET failed_attempts = 0, locked_until = 0, last_seen_at = ? WHERE id = ?`,
    [now, u.id]);
  return {
    userId: u.id,
    username: u.username,
    role: u.role_name,
    permissions: JSON.parse(u.permissions || '[]'),
  };
}

// ── Audit log ─────────────────────────────────────────────────────────────
async function audit(reqOrUser, action, target, details) {
  const user = reqOrUser && reqOrUser.user ? reqOrUser.user : reqOrUser;
  const uid  = user ? user.userId || null : null;
  const name = user ? user.username || null : null;
  const det  = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
  try {
    await db.run(`INSERT INTO audit_log (ts, user_id, username, action, target, details) VALUES (?, ?, ?, ?, ?, ?)`,
      [Date.now(), uid, name, action, target == null ? null : String(target), det]);
  } catch (e) { /* audit failures must never break a request */ }
}
async function listAudit({ limit = 100, offset = 0, action, userId } = {}) {
  const where = [], params = [];
  if (action) { where.push('action = ?'); params.push(action); }
  if (userId) { where.push('user_id = ?'); params.push(userId); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(Math.min(500, Math.max(1, limit)), Math.max(0, offset));
  return db.all(`SELECT id, ts, user_id, username, action, target, details
    FROM audit_log ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`, params);
}

module.exports = {
  PERMISSIONS, ALL_PERMS, ADMIN_ROLE, USER_ROLE,
  SESSION_COOKIE, SESSION_TTL_MS,
  ensureBuiltinRoles, needsSetup, countAdmins,
  createUser, getUserById, listUsers, setUserRole, setUserDisabled, resetUserPin, deleteUser,
  listRoles, createRole, updateRole, deleteRole,
  createSession, getSession, touchSession, deleteSession, deleteSessionsForUser, pruneExpiredSessions,
  verifyPin, audit, listAudit,
  validateUsername, validatePin,
};
