// Aurora 2 UI smoke + screenshot run on an emulated iPhone (home-screen app size)
// and a desktop window. Fails loudly on any page error.
// Usage: AURORA_TOKEN=… node smoke.mjs [outDir]   (AURORA_URL defaults to http://127.0.0.1:8091)
import { chromium } from 'playwright';

import fs from 'node:fs';
const OUT = process.argv[2] || new URL('./out', import.meta.url).pathname;
const TOKEN = process.env.AURORA_TOKEN, ONLY = process.env.ONLY || '';
const BASE = process.env.AURORA_URL || 'http://127.0.0.1:8091';
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
if (!TOKEN) { console.error('Set AURORA_TOKEN (dev-server.sh prints it)'); process.exit(2); }
const browser = await chromium.launch();

async function newPage(viewport, mobile) {
  const ctx = await browser.newContext({
    viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile,
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' : undefined,
  });
  await ctx.addCookies([{ name: 'aurora_sid', value: TOKEN, url: BASE }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => { const u = r.url(); if (!/thumb|video|fonts/.test(u)) errors.push('reqfail: ' + u + ' ' + (r.failure() && r.failure().errorText)); });
  return page;
}
const shot = async (page, name, wait = 700) => { await page.waitForTimeout(wait); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name); };
const ev = (page, fn, arg) => page.evaluate(fn, arg);

const m = await newPage({ width: 393, height: 852 }, true);
await m.goto(`${BASE}/aurora`, { waitUntil: 'domcontentloaded' });
await m.waitForFunction(() => document.querySelectorAll('#photoGrid .tile img').length > 8, null, { timeout: 25000 });
await shot(m, '01-library', 2200);

if (!ONLY || ONLY === 'lib') {
  await ev(m, () => document.getElementById('libScroll').scrollBy(0, 2600));
  await shot(m, '02-library-scrolled', 1200);
  await ev(m, () => document.querySelector('[data-zoomview="months"]').click());
  await shot(m, '03-months', 1500);
  await ev(m, () => document.querySelector('[data-zoomview="years"]').click());
  await shot(m, '04-years', 1500);
  await ev(m, () => document.querySelector('[data-zoomview="all"]').click());
  await ev(m, () => document.getElementById('libScroll').scrollTo(0, 0));
  await ev(m, () => document.getElementById('libViewBtn').click());
  await shot(m, '05-view-menu', 600);
  await ev(m, () => closeMenus());
}

// Viewer
await ev(m, () => document.querySelectorAll('#photoGrid .tile')[2].click());
await shot(m, '06-viewer', 1800);
await ev(m, () => toggleMetaPanel());
await shot(m, '07-viewer-info', 1800);
await ev(m, () => { closeMetaPanel(); closeLightbox(); });
await m.waitForTimeout(500);

// Select mode
await ev(m, () => { toggleSelectMode(); [4, 5, 6, 9].forEach(i => toggleSelect(libGrid.items[i].id)); });
await shot(m, '08-select', 700);
await ev(m, () => document.getElementById('selMoreBtn').click());
await shot(m, '09-select-more', 600);
await ev(m, () => { closeMenus(); exitSelectMode(); });

// Search
await ev(m, () => switchScreen('search'));
await shot(m, '10-search-discover', 2200);
await m.fill('#searchInput', 'beach');
await m.press('#searchInput', 'Enter');
await m.waitForFunction(() => document.querySelectorAll('#searchGrid .tile').length > 4, null, { timeout: 15000 });
await shot(m, '11-search-results', 1500);
await ev(m, () => document.querySelector('[data-facet="country"]').click());
await shot(m, '12-search-facet', 900);
await ev(m, () => closeAllSheets());

// Places
await ev(m, () => switchScreen('places'));
await shot(m, '13-places', 3000);
await ev(m, () => { const p = document.querySelector('.ppin'); if (p) { p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 })); p.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 })); } });
await shot(m, '14-place-sheet', 2000);

// Collections
await ev(m, () => switchScreen('collections'));
await shot(m, '15-collections', 2500);
await ev(m, () => openSmartDetail('favorites'));
await shot(m, '16-detail-favs', 2200);
await ev(m, () => closeDetail());
await m.waitForTimeout(500);

// Account + settings
await ev(m, () => openAccountSheet());
await shot(m, '17-account', 900);
await ev(m, () => { closeAccountSheet(); openSettings(); });
await shot(m, '18-settings', 1500);
await ev(m, () => openSettingsPage('overview'));
await shot(m, '19-overview', 1800);
await ev(m, () => { settingsBack(); openSettingsPage('users'); });
await shot(m, '20-users', 1500);
await ev(m, () => { settingsBack(); openSettingsPage('update'); });
await shot(m, '21-update', 2500);
await ev(m, () => { settingsBack(); openSettingsPage('sources'); });
await shot(m, '22-sources', 1500);
await ev(m, () => closeSettings());

// Range sheet
await ev(m, () => switchScreen('library'));
await ev(m, () => openLibraryRange());
await shot(m, '23-range', 900);
await ev(m, () => closeAllSheets());

// Desktop
const d = await newPage({ width: 1440, height: 900 }, false);
await d.goto(`${BASE}/aurora`, { waitUntil: 'domcontentloaded' });
await d.waitForFunction(() => document.querySelectorAll('#photoGrid .tile img').length > 8, null, { timeout: 25000 });
await shot(d, '30-desktop-library', 2000);
await ev(d, () => document.querySelectorAll('#photoGrid .tile')[1].click());
await ev(d, () => toggleMetaPanel());
await shot(d, '31-desktop-viewer', 2000);
await ev(d, () => { closeLightbox(); openSettings(); openSettingsPage('overview'); });
await shot(d, '32-desktop-settings', 1500);

console.log('ERRORS', JSON.stringify(errors, null, 1));
await browser.close();
