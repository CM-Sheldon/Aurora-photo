/**
 * Static UI regression checks against the sign-in page and the Aurora 2 app
 * (views/aurora.ejs + views/partials/*.ejs + public/ui/css + public/ui/js).
 *
 * Not a substitute for browser testing (see DEVELOPMENT.md for the headless
 * iPhone runs), but they catch specific bugs and rules coming back:
 *   - the login "red box always visible" bug (auth.ejs)
 *   - the PWA safe-area / dvh handling
 *   - permission gating of the favourite controls
 *   - performance rules: blur only on allow-listed floating pieces, no
 *     saturate(), Live Photo previews only for a real mouse
 *   - structural integrity: every /ui file the shell loads exists, every
 *     inline handler in the markup resolves to a real function
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const AUTH = fs.readFileSync(path.join(ROOT, 'views', 'auth.ejs'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'views', 'aurora.ejs'), 'utf8');

function readTree(dir, exts) {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return readTree(p, exts);
      return exts.some((e) => d.name.endsWith(e)) ? fs.readFileSync(p, 'utf8') + '\n' : '';
    }).join('');
}
const PARTIALS = readTree(path.join(ROOT, 'views', 'partials'), ['.ejs']);
// Comments stripped so prose like "no saturate()" doesn't trip the rule checks.
const CSS = readTree(path.join(ROOT, 'public', 'ui', 'css'), ['.css']).replace(/\/\*[\s\S]*?\*\//g, '');
const JS = readTree(path.join(ROOT, 'public', 'ui', 'js'), ['.js']);
const MARKUP = SHELL + '\n' + PARTIALS;
const APP = [MARKUP, CSS, JS].join('\n');

// ── auth.ejs (sign-in page) ────────────────────────────────────────────────

test('auth.ejs: the initial error box has no .show class (so it starts hidden)', () => {
  const el = AUTH.match(/<div[^>]*id="err"[^>]*>/);
  assert.ok(el, 'error placeholder <div id="err"> not found');
  assert.doesNotMatch(el[0], /class="[^"]*\bshow\b[^"]*"/,
    'initial error placeholder must not have .show — page would render an empty red box');
  assert.match(AUTH, /classList\.add\(\s*['"`]show['"`]\s*\)/, 'JS must add the .show class when an error is displayed');
  assert.match(AUTH, /classList\.remove\(\s*['"`]show['"`]\s*\)/, 'JS must remove .show to clear the error');
});

test('auth.ejs: .msg.err by itself does not force display:block', () => {
  const errRule = AUTH.match(/\.msg\.err\s*\{[^}]*\}/);
  assert.ok(errRule, '.msg.err rule not found');
  assert.doesNotMatch(errRule[0], /display:\s*block/, '.msg.err on its own must not set display:block');
  assert.match(AUTH, /\.msg\.err\.show\s*\{[^}]*display:\s*block/, '.msg.err.show should be the rule that reveals the error');
});

// ── Shell / PWA ────────────────────────────────────────────────────────────

test('app shell uses 100dvh alongside 100vh so the iOS PWA leaves no gaps', () => {
  assert.match(CSS, /\.app\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh/, '.app needs height:100vh then height:100dvh');
});

test('html has an explicit background so PWA safe-area gaps never flash white', () => {
  assert.match(CSS, /html,\s*body\s*\{[^}]*background:\s*var\(--canvas\)/, 'html, body { background: var(--canvas) } expected');
});

test('viewport opts into the safe areas and the floating bars clear the home indicator', () => {
  assert.match(SHELL, /viewport-fit=cover/, 'viewport meta must include viewport-fit=cover');
  assert.match(CSS, /--tab-gap:\s*max\([^;]*env\(safe-area-inset-bottom/, '--tab-gap must account for safe-area-inset-bottom');
  assert.match(CSS, /\.tabbar\s*\{[^}]*bottom:\s*var\(--tab-gap\)/, 'the tab bar must sit at --tab-gap');
  assert.match(CSS, /\.screen-head\.over\s*\{[^}]*padding-top:\s*calc\(var\(--safe-top\)/, 'overlay headers must clear the status bar');
});

test('no Google Fonts or other third-party font requests (works offline, nothing leaves the LAN)', () => {
  for (const [name, src] of [['aurora.ejs + partials', MARKUP], ['ui css', CSS], ['auth.ejs', AUTH]]) {
    assert.doesNotMatch(src, /fonts\.googleapis|fonts\.gstatic/, `${name} must not load Google Fonts`);
  }
});

// ── Permissions ────────────────────────────────────────────────────────────

test('favourite controls are permission-gated', () => {
  assert.match(JS, /havePerm\(\s*['"`]photos\.favorite['"`]\s*\)/, 'client must check photos.favorite before offering ♥');
  assert.match(MARKUP, /id="lbFavBtn"[^>]*data-perm="photos\.favorite"/, 'viewer ♥ must be data-perm-gated');
});

test('admin lists render as rows, not sideways-scrolling tables', () => {
  assert.doesNotMatch(PARTIALS, /<table/i, 'settings should not use tables (they scroll sideways on phones)');
  for (const id of ['usersList', 'rolesList', 'auditList']) assert.match(PARTIALS, new RegExp(`id="${id}"`), `#${id} missing`);
});

// ── Performance rules (see v1.5 notes) ─────────────────────────────────────

test('no saturate() anywhere — the colour-matrix pass tanked mobile scrolling', () => {
  assert.doesNotMatch(CSS, /saturate\(/);
});

test('backdrop-filter only on allow-listed small floating pieces', () => {
  // A full-width bar with blur, with content scrolling under it, repaints a
  // full-frame blur on every scroll tick on iPhone. Adding blur to a new
  // selector must be a deliberate decision: extend this list on purpose.
  const ALLOWED = ['.glass', '.gbtn', '.dialog', '.menu', '.lb-close', 'html.no-blur .glass', 'html.no-blur .gbtn'];
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector, body] of rules) {
    if (!/backdrop-filter:\s*blur/.test(body)) continue;
    for (const sel of selector.split(',').map((s) => s.trim()).filter(Boolean)) {
      assert.ok(ALLOWED.includes(sel), `backdrop-filter blur on "${sel}" is not allow-listed`);
    }
  }
});

test('Live Photo hover previews only spawn for a real mouse', () => {
  assert.match(JS, /pointerType\s*!==\s*['"]mouse['"]/, 'preview code must gate on pointerType === mouse');
});

// ── Structural integrity ───────────────────────────────────────────────────

test('every /ui file the shell loads exists', () => {
  const css = SHELL.match(/const CSS = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const js = SHELL.match(/const JS = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  for (const f of css) assert.ok(fs.existsSync(path.join(ROOT, 'public', 'ui', 'css', f + '.css')), `missing css/${f}.css`);
  for (const f of js) assert.ok(fs.existsSync(path.join(ROOT, 'public', 'ui', 'js', f + '.js')), `missing js/${f}.js`);
  for (const p of (SHELL.match(/include\('([^']+)'\)/g) || []).map((s) => s.slice(9, -2))) {
    assert.ok(fs.existsSync(path.join(ROOT, 'views', p + '.ejs')), `missing views/${p}.ejs`);
  }
});

test('every inline on*= handler in the markup calls a function that exists', () => {
  const defined = new Set();
  for (const m of JS.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
  const missing = new Set();
  for (const m of APP.matchAll(/on(?:click|change|input)="([^"]*)"/g)) {
    for (const c of m[1].matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!defined.has(c[1]) && !['if'].includes(c[1])) missing.add(c[1]);
    }
  }
  assert.deepEqual([...missing], [], 'inline handlers reference undefined functions');
});

test('the in-app updater stays wired (check → install → poll → hard reload)', () => {
  for (const fn of ['checkForUpdates', 'applyGitHubUpdate', 'applyUpdate', 'startUpdatePoller', 'checkPendingUpdate', 'hardReload', 'checkServerBuild']) {
    assert.match(JS, new RegExp(`function ${fn}\\(`), `${fn}() missing`);
  }
  for (const ep of ['/settings/update/check', '/settings/update/apply-github', '/settings/update/apply', '/settings/update/status', '/api/aurora/version']) {
    assert.ok(JS.includes(ep), `client no longer calls ${ep}`);
  }
  for (const id of ['updateApplyBtn', 'updateCheckBtn', 'updateZipPath', 'updateApplyLocalBtn', 'updateStatus']) {
    assert.match(PARTIALS, new RegExp(`id="${id}"`), `#${id} missing from the Software update page`);
  }
});
