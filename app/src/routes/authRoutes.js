/**
 * Aurora auth API.
 *
 * All routes live under /api/aurora/auth/* and are the ONLY endpoints that
 * bypass requireAuth. `/me` also lives here (under /api/aurora/me) but is
 * mounted separately by the caller because it should require auth.
 */
const express = require('express');
const router = express.Router();
const auth = require('../services/auroraAuthService');
const { requireAuth, requirePerm } = require('../middleware/auth');

function cookieOpts(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // The app is normally served over plain HTTP on a LAN. Only set Secure when
    // the request actually came in on HTTPS (via trust proxy) — otherwise the
    // browser silently drops the cookie and login mysteriously fails.
    secure: !!(req.secure),
    maxAge: auth.SESSION_TTL_MS,
    path: '/',
  };
}

// ── Public discovery endpoint used by /login and /setup pages ─────────────
router.get('/status', async (req, res) => {
  try {
    const needsSetup = await auth.needsSetup();
    res.json({ needsSetup, signedIn: !!req.user, user: req.user ? {
      username: req.user.username, role: req.user.role, permissions: req.user.permissions,
    } : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── First-run: claim admin ────────────────────────────────────────────────
// Only works while there are zero admins in the DB. Returns 409 otherwise so a
// second browser hitting /setup can't create a rogue admin behind the first
// visitor's back.
router.post('/setup', async (req, res) => {
  try {
    if (!(await auth.needsSetup())) return res.status(409).json({ error: 'Setup already complete' });
    const { username, pin } = req.body || {};
    // First admin picks their own PIN in the setup form — no forced change.
    const id = await auth.createUser({ username, pin, roleName: auth.ADMIN_ROLE.name, mustChangePin: false });
    const token = await auth.createSession(id, req.headers['user-agent']);
    res.cookie(auth.SESSION_COOKIE, token, cookieOpts(req));
    await auth.audit({ userId: id, username }, 'auth.setup', String(id));
    res.json({ ok: true, username });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/login', async (req, res) => {
  try {
    const { username, pin } = req.body || {};
    const u = await auth.verifyPin(username, pin);
    const token = await auth.createSession(u.userId, req.headers['user-agent']);
    res.cookie(auth.SESSION_COOKIE, token, cookieOpts(req));
    await auth.audit(u, 'auth.login', String(u.userId));
    res.json({
      ok: true, username: u.username, role: u.role, permissions: u.permissions,
      mustChangePin: !!u.mustChangePin,
    });
  } catch (e) {
    await auth.audit(null, 'auth.login.fail', (req.body && req.body.username) || null, { reason: e.message });
    res.status(401).json({ error: e.message });
  }
});

// Self-service PIN change (avatar menu → Change PIN). Also handles the forced
// change after an admin reset — same endpoint, same validation.
router.post('/change-pin', requireAuth, async (req, res) => {
  try {
    const { currentPin, newPin } = req.body || {};
    if (!currentPin || !newPin) return res.status(400).json({ error: 'currentPin and newPin are required' });
    await auth.changeOwnPin(req.user.userId, currentPin, newPin, req.user.token);
    await auth.audit(req.user, 'auth.pin.change', String(req.user.userId));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/logout', async (req, res) => {
  try {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith(auth.SESSION_COOKIE + '='));
    if (match) {
      const token = decodeURIComponent(match.slice(auth.SESSION_COOKIE.length + 1));
      await auth.deleteSession(token);
    }
    if (req.user) await auth.audit(req.user, 'auth.logout', String(req.user.userId));
    res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Signed-in identity + permission catalog (used by the SPA) ─────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role,
    permissions: req.user.permissions,
    mustChangePin: !!req.user.mustChangePin,
    permissionCatalog: auth.PERMISSIONS,
  });
});

// ── Admin: users ──────────────────────────────────────────────────────────
router.get('/admin/users', requireAuth, requirePerm('users.manage'), async (req, res) => {
  try { res.json({ users: await auth.listUsers() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/admin/users', requireAuth, requirePerm('users.manage'), async (req, res) => {
  try {
    const { username, pin, role } = req.body || {};
    const id = await auth.createUser({ username, pin, roleName: role || auth.USER_ROLE.name });
    await auth.audit(req.user, 'user.create', String(id), { username, role });
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/admin/users/:id/role', requireAuth, requirePerm('users.manage'), async (req, res) => {
  try {
    await auth.setUserRole(+req.params.id, (req.body || {}).role);
    await auth.audit(req.user, 'user.role', req.params.id, { role: (req.body || {}).role });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/admin/users/:id/disabled', requireAuth, requirePerm('users.manage'), async (req, res) => {
  try {
    await auth.setUserDisabled(+req.params.id, !!(req.body || {}).disabled);
    await auth.audit(req.user, 'user.disabled', req.params.id, { disabled: !!(req.body || {}).disabled });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/admin/users/:id/pin', requireAuth, requirePerm('users.manage'), async (req, res) => {
  try {
    await auth.resetUserPin(+req.params.id, (req.body || {}).pin);
    await auth.audit(req.user, 'user.pin.reset', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/admin/users/:id', requireAuth, requirePerm('users.manage'), async (req, res) => {
  try {
    await auth.deleteUser(+req.params.id);
    await auth.audit(req.user, 'user.delete', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Admin: roles ──────────────────────────────────────────────────────────
router.get('/admin/roles', requireAuth, requirePerm('roles.manage'), async (req, res) => {
  try { res.json({ roles: await auth.listRoles(), catalog: auth.PERMISSIONS }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/admin/roles', requireAuth, requirePerm('roles.manage'), async (req, res) => {
  try {
    const { name, permissions } = req.body || {};
    const id = await auth.createRole({ name, permissions });
    await auth.audit(req.user, 'role.create', String(id), { name, permissions });
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/admin/roles/:id', requireAuth, requirePerm('roles.manage'), async (req, res) => {
  try {
    await auth.updateRole(+req.params.id, req.body || {});
    await auth.audit(req.user, 'role.update', req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/admin/roles/:id', requireAuth, requirePerm('roles.manage'), async (req, res) => {
  try {
    await auth.deleteRole(+req.params.id);
    await auth.audit(req.user, 'role.delete', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Admin: audit log viewer ───────────────────────────────────────────────
router.get('/admin/audit', requireAuth, requirePerm('audit.view'), async (req, res) => {
  try {
    const rows = await auth.listAudit({
      limit: +req.query.limit || 200,
      offset: +req.query.offset || 0,
      action: req.query.action || undefined,
      userId: req.query.userId ? +req.query.userId : undefined,
    });
    res.json({ entries: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
