/**
 * Aurora auth middleware.
 *
 * attachSession    — populates req.user (or null) from the session cookie.
 * requireAuth      — 401s (JSON) or redirects (HTML) if req.user is missing.
 * requirePerm(key) — 403s if the logged-in user lacks the given permission.
 */
const auth = require('../services/auroraAuthService');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

async function attachSession(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[auth.SESSION_COOKIE];
    if (token) {
      const s = await auth.getSession(token);
      if (s) {
        req.user = s;
        // Rolling expiry — cheap, and only for actual API/page hits.
        auth.touchSession(token).catch(() => {});
      }
    }
  } catch (_) { /* ignore — treat as anonymous */ }
  next();
}

// True if the request expects JSON (an API call from the SPA). Used to decide
// between 401 JSON and a redirect to /login. Uses originalUrl because Express
// strips the mount prefix off req.path once we're inside a mounted router.
function wantsJson(req) {
  if ((req.originalUrl || '').startsWith('/api/')) return true;
  const a = req.headers.accept || '';
  return a.includes('application/json') && !a.includes('text/html');
}

// Endpoints that MUST stay reachable without a session cookie because they're
// called by non-interactive background workers (e.g. the vision-caption worker
// running on a separate machine POSTs to /captions/ingest). Keep this list
// tight — every entry is an auth bypass.
const AUTH_BYPASS = new Set(['/captions/ingest']);

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (AUTH_BYPASS.has(req.path)) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Not signed in' });
  const next_ = encodeURIComponent(req.originalUrl || '/aurora');
  return res.redirect(`/login?next=${next_}`);
}

function requirePerm(key) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if ((req.user.permissions || []).includes(key)) return next();
    return res.status(403).json({ error: `Missing permission: ${key}` });
  };
}

module.exports = { attachSession, requireAuth, requirePerm, parseCookies };
