/**
 * Static UI regression checks against auth.ejs and aurora.ejs.
 *
 * These aren't a substitute for real browser testing, but they catch the
 * specific sprint bugs coming back:
 *   - the login "red box always visible" bug (auth.ejs)
 *   - the PWA safe-area / dvh handling (aurora.ejs)
 *   - the ♥ fav button rendering behind a permission check
 *   - the RBAC tables being wrapped so they scroll on narrow screens
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AUTH = fs.readFileSync(path.join(__dirname, '..', 'views', 'auth.ejs'), 'utf8');
const APP  = fs.readFileSync(path.join(__dirname, '..', 'views', 'aurora.ejs'), 'utf8');

// ── auth.ejs (login page) ──────────────────────────────────────────────────

test('auth.ejs: the initial error box has no .show class (so it starts hidden)', () => {
  // The old markup + old CSS combined to a red box that was always visible on
  // page load because `.msg.err { display: block }` fired regardless of state.
  // The fix keeps the .err colour styling on the element but gates VISIBILITY
  // on a separate .show class that JS toggles.
  const el = AUTH.match(/<div[^>]*id="err"[^>]*>/);
  assert.ok(el, 'error placeholder <div id="err"> not found');
  assert.doesNotMatch(el[0], /class="[^"]*\bshow\b[^"]*"/,
    'initial error placeholder must not have .show — page would render an empty red box');
  assert.match(AUTH, /classList\.add\(\s*['"`]show['"`]\s*\)/,
    'JS must add the .show class when an error is displayed');
  assert.match(AUTH, /classList\.remove\(\s*['"`]show['"`]\s*\)/,
    'JS must remove .show to clear the error');
});

test('auth.ejs: .msg.err by itself no longer forces display:block', () => {
  // Old: `.msg.err { display: block; ... }`  — always visible.
  // New: `.msg.err.show { display: block; }` — visible only when JS adds .show.
  const errRule = AUTH.match(/\.msg\.err\s*\{[^}]*\}/);
  assert.ok(errRule, '.msg.err rule not found');
  assert.doesNotMatch(errRule[0], /display:\s*block/,
    '.msg.err on its own must not set display:block');
  assert.match(AUTH, /\.msg\.err\.show\s*\{[^}]*display:\s*block/,
    '.msg.err.show should be the rule that reveals the error');
});

// ── aurora.ejs (main app) ──────────────────────────────────────────────────

test('aurora.ejs: uses 100dvh alongside 100vh so iOS PWA does not leave gaps', () => {
  // dvh tracks the visible viewport on iOS PWA; vh alone leaves the "wasted
  // space above and below" reported for the Apple standalone install.
  assert.match(APP, /\.app\s*\{[^}]*height:\s*100dvh/,
    '.app should include height: 100dvh (fallback to 100vh is fine to keep)');
});

test('aurora.ejs: html element has an explicit background so PWA safe-area gaps do not flash white', () => {
  assert.match(APP, /html\s*\{\s*background:\s*var\(--void\)/,
    'html { background: var(--void) } needed to hide iOS safe-area seams');
});

test('aurora.ejs: standalone (PWA) media query pads the bottom nav past the home indicator', () => {
  assert.match(APP, /@media\s*\(display-mode:\s*standalone\)\s*\{[\s\S]{0,400}\.bottom-nav[^}]*env\(safe-area-inset-bottom\)/,
    'standalone rule should extend safe-area handling to the bottom nav');
});

test('aurora.ejs: fav tile button is behind a havePerm("photos.favorite") gate', () => {
  assert.match(APP, /havePerm\(\s*['"`]photos\.favorite['"`]\s*\)/,
    'client should hide the ♥ button when the role lacks photos.favorite');
});

test('aurora.ejs: lightbox fav button has data-perm="photos.favorite"', () => {
  assert.match(APP, /id="lbFavBtn"[^>]*data-perm="photos\.favorite"/,
    'lightbox ♥ button must be data-perm-gated so applyPermissionsToUI hides it');
});

test('aurora.ejs: RBAC tables are wrapped in .rbac-table-wrap for horizontal scroll on mobile', () => {
  const wrapCount = (APP.match(/rbac-table-wrap/g) || []).length;
  // 3 tables (users, roles, audit) + 1 CSS rule declaration = at least 4 matches.
  assert.ok(wrapCount >= 4,
    `expected the three RBAC tables to be wrapped in .rbac-table-wrap (found ${wrapCount} references)`);
});

test('aurora.ejs: settings-content padding is tightened on mobile', () => {
  // The mobile rule reduces the 24px desktop padding so tiles fit on 375px screens.
  assert.match(APP,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.settings-content\s*\{[^}]*padding:\s*14px/,
    'mobile @media should tighten .settings-content padding');
});
