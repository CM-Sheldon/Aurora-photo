/**
 * Route → permission mapping. This is a static audit that guards against
 * regressions like the sprint bug where POST /fav/:id was mounted without a
 * requirePerm() wrapper.
 *
 * Approach: parse routes/aurora.js as text and, for each write-shaped route
 * (POST/PUT/DELETE, and certain sensitive GETs) assert that the router.*()
 * call either includes a requirePerm() or is on the explicit allowlist
 * below. Cheaper and more portable than spinning up express + a live DB.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'aurora.js'), 'utf8');

// Routes that legitimately have no requirePerm — either they must remain open
// (login, worker ingest) or they are read-only reads reused across all roles
// with a photos.view-shaped session (the app-wide login is what gates them).
// Keep this list tight: every entry is an audit exemption.
const ALLOW_NO_PERM = new Set([
  // Reads the app makes on every screen — gated by requireAuth (the login),
  // not by a per-perm check. If we later add a "no-photos" role, revisit.
  "get:/assets",
  "get:/asset/:id",
  "get:/assets/index",
  "get:/thumb/:id",
  "get:/video/:id",
  "get:/places",
  "get:/worldmap",
  "get:/stats",
  "get:/cameras",
  "get:/countries",
  "get:/tags",
  "get:/tags/:tagId/photos",
  "post:/tags/for-assets",
  "get:/albums",
  // Caption worker (POST is auth-bypassed in the middleware allowlist).
  "post:/captions/ingest",
  "get:/captions/pending",
  "get:/captions/image/:id",
  "get:/captions/status",
  // Import progress polling used by the import screen — no side effects.
  "get:/import/progress/:sessionId",
  "get:/import/progress/:sessionId/stream",
  // Auth-related endpoints live in a separate router; nothing in aurora.js.
]);

function extractRoutes(src) {
  // Find each router.<method>('<path>', ...) call and snapshot the next ~300
  // chars so we can look for requirePerm() without trying to balance parens
  // across handlers that themselves call methods with parentheses inside.
  const out = [];
  const re = /router\.(get|post|put|delete)\(\s*(['"`])([^'"`]+)\2/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const method = m[1];
    const routePath = m[3];
    const rest = src.slice(m.index, m.index + 300);
    out.push({ method, path: routePath, rest });
  }
  return out;
}

test('every write-shaped route in aurora.js is either gated by requirePerm() or explicitly allowlisted', () => {
  const routes = extractRoutes(SRC);
  assert.ok(routes.length > 20, `expected many routes, saw ${routes.length}`);

  const missing = [];
  for (const r of routes) {
    const key = `${r.method}:${r.path}`;
    const guarded = /requirePerm\(/.test(r.rest);
    if (guarded) continue;
    if (ALLOW_NO_PERM.has(key)) continue;
    missing.push(key);
  }
  assert.deepEqual(missing, [],
    `these routes have no requirePerm() and are not on the allowlist:\n  ${missing.join('\n  ')}\n\n` +
    `Either add requirePerm('<key>') to the route or add the entry to ALLOW_NO_PERM ` +
    `in tests/routes-perm.test.js with a note explaining why.`);
});

test('POST /fav/:id specifically requires photos.favorite', () => {
  const routes = extractRoutes(SRC);
  const fav = routes.find(r => r.method === 'post' && r.path === '/fav/:id');
  assert.ok(fav, 'POST /fav/:id must exist');
  assert.match(fav.rest, /requirePerm\(\s*['"`]photos\.favorite['"`]\s*\)/,
    'POST /fav/:id must be gated by photos.favorite (sprint regression guard)');
});
