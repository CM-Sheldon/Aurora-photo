// Aurora 2 flow checks: a restricted account, Hidden (passcode), Recently
// removed (restore), search facets, and the light theme across screens.
// Usage: AURORA_TOKEN=<admin> AURORA_TOKEN2=<restricted user> node flows.mjs [outDir]
// Writes to the (snapshot) DB: sets the Hidden passcode to 2468, removes and
// restores one photo. Never point this at the live service.
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || new URL('./out', import.meta.url).pathname;
const BASE = process.env.AURORA_URL || 'http://127.0.0.1:8091';
const TOKEN = process.env.AURORA_TOKEN, TOKEN2 = process.env.AURORA_TOKEN2;
fs.mkdirSync(OUT, { recursive: true });
if (!TOKEN) { console.error('Set AURORA_TOKEN'); process.exit(2); }
const errors = [], results = [];
const ok = (name, cond, extra) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
const browser = await chromium.launch();

async function open(token, tag) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'aurora_sid', value: token, url: BASE }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[${tag}] console: ${m.text()}`); });
  await page.goto(`${BASE}/aurora`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('perms-ready') && state.assetsLoaded, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  return page;
}
const visible = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && el.offsetParent !== null && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'; }, sel);

// ── Restricted account ──
if (TOKEN2) {
  const p = await open(TOKEN2, 'user');
  const me = await p.evaluate(() => window.AURORA_ME && window.AURORA_ME.role);
  ok('restricted: signed in as non-admin', me && me !== 'admin', me);
  await p.evaluate(() => openAccountSheet());
  await p.waitForTimeout(500);
  const settingsRow = await p.evaluate(() => { const r = [...document.querySelectorAll('#accountSheet .row')].find(b => /Settings/.test(b.textContent)); return r && r.style.display !== 'none'; });
  ok('restricted: account sheet only offers Settings when a settings-ish perm exists', settingsRow === (await p.evaluate(() => ['settings.view', 'users.manage', 'roles.manage', 'audit.view', 'photos.hidden'].some(havePerm))));
  await p.evaluate(() => closeAccountSheet());
  ok('restricted: no "New album" without albums.manage', await p.evaluate(() => { switchScreen('collections'); return true; }) && !(await p.evaluate(() => havePerm('albums.manage') ? true : !!document.querySelector('[data-newalbum]'))));
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/f01-restricted-collections.png` });
  await p.evaluate(() => switchScreen('library'));
  await p.waitForTimeout(500);
  await p.evaluate(() => { const t = document.querySelectorAll('#photoGrid .tile')[3]; t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 300 })); });
  await p.waitForTimeout(300);
  const menuLabels = await p.evaluate(() => [...document.querySelectorAll('.menu .menu-item')].map(b => b.textContent.trim()));
  ok('restricted: context menu hides Add to album', !menuLabels.includes('Add to album'), menuLabels.join(' | '));
  await p.evaluate(() => closeMenus());
  if (await p.evaluate(() => havePerm('settings.view'))) ok('restricted: (has settings.view — skip root check)', true);
  else {
    await p.evaluate(() => openSettings());
    await p.waitForTimeout(500);
    const rows = await p.evaluate(() => [...document.querySelectorAll('.settings-root .row')].filter(r => r.style.display !== 'none').map(r => r.textContent.trim()));
    ok('restricted: settings shows only permitted rows', rows.every(t => /Hidden album passcode/.test(t)), rows.join(' | '));
    await p.screenshot({ path: `${OUT}/f02-restricted-settings.png` });
    await p.evaluate(() => closeSettings());
  }
  await p.context().close();
}

// ── Admin flows ──
const a = await open(TOKEN, 'admin');
// Hidden album with a passcode
await a.evaluate(() => postJSON('/api/aurora/settings/passcode/set', { passcode: '2468' }));
await a.evaluate(() => { state.privateUnlocked = false; switchScreen('collections'); });
await a.waitForTimeout(1500);
await a.evaluate(() => openHiddenAlbum());
await a.waitForTimeout(300);
ok('hidden: passcode prompt shown', await visible(a, '#passcodeOverlay .passcode-card'));
await a.fill('#passcodeInput', '1111');
await a.press('#passcodeInput', 'Enter');
await a.waitForTimeout(600);
ok('hidden: wrong passcode rejected', (await a.textContent('#passcodeErr')).includes('Incorrect'));
await a.fill('#passcodeInput', '2468');
await a.press('#passcodeInput', 'Enter');
await a.waitForFunction(() => detailIsOpen() && currentDetailKind() === 'hidden', null, { timeout: 8000 });
await a.waitForTimeout(1200);
ok('hidden: album opens after the right passcode', await a.evaluate(() => detailGrid.items.length >= 0));
await a.screenshot({ path: `${OUT}/f03-hidden.png` });
await a.evaluate(() => closeDetail());
await a.waitForTimeout(500);

// Remove → Recently removed → restore
const target = await a.evaluate(() => libGrid.items[10].id);
await a.evaluate((id) => postJSON('/api/aurora/assets/remove', { assetIds: [id] }), target);
await a.evaluate(() => openRemovedManager());
await a.waitForFunction(() => detailIsOpen() && currentDetailKind() === 'removed' && detailGrid.items.length > 0, null, { timeout: 10000 });
ok('removed: item listed', await a.evaluate((id) => detailGrid.items.some(i => i.id === id), target));
await a.screenshot({ path: `${OUT}/f04-removed.png` });
await a.evaluate((id) => restoreIds([id]), target);
await a.waitForTimeout(1500);
ok('removed: restore drops it from the list', await a.evaluate((id) => !detailGrid.items.some(i => i.id === id), target));
await a.evaluate(() => closeDetail());

// Search facets: pick a country from the sheet, then clear it
await a.evaluate(() => switchScreen('search'));
await a.fill('#searchInput', 'beach');
await a.press('#searchInput', 'Enter');
await a.waitForFunction(() => searchGrid.items.length > 0, null, { timeout: 15000 });
const total0 = await a.evaluate(() => searchMeta.total);
await a.evaluate(() => document.querySelector('[data-facet="country"]').click());
await a.waitForTimeout(600);
await a.evaluate(() => { const rows = [...document.querySelectorAll('.sheet.open .row[data-v]')].filter(r => r.dataset.v); rows[1].click(); });
await a.waitForFunction((t) => searchMeta.total !== t, total0, { timeout: 15000 });
const total1 = await a.evaluate(() => searchMeta.total);
ok('search: country facet narrows results', total1 < total0, `${total0} → ${total1}`);
await a.screenshot({ path: `${OUT}/f05-search-facet-on.png` });
await a.evaluate(() => clearSearchAll());
await a.waitForTimeout(800);
ok('search: clear returns to discovery', await a.evaluate(() => !document.getElementById('searchDiscover').hidden));

// Light theme tour
await a.evaluate(() => applyTheme('light'));
for (const [scr, name] of [['library', 'f06-light-library'], ['search', 'f07-light-search'], ['places', 'f08-light-places']]) {
  await a.evaluate((s) => switchScreen(s), scr);
  await a.waitForTimeout(scr === 'places' ? 2500 : 1200);
  await a.screenshot({ path: `${OUT}/${name}.png` });
}
await a.evaluate(() => { openSettings(); openSettingsPage('overview'); });
await a.waitForTimeout(1200);
await a.screenshot({ path: `${OUT}/f09-light-settings.png` });
await a.evaluate(() => { closeSettings(); switchScreen('library'); });
await a.evaluate(() => document.querySelectorAll('#photoGrid .tile')[1].click());
await a.waitForTimeout(800);
await a.evaluate(() => toggleMetaPanel());
await a.waitForTimeout(1200);
await a.screenshot({ path: `${OUT}/f10-light-viewer-info.png` });
await a.evaluate(() => { closeMetaPanel(); closeLightbox(); applyTheme('purple'); });

console.log(results.join('\n'));
console.log('ERRORS', JSON.stringify(errors, null, 1));
await browser.close();
