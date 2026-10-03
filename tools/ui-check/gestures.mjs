// Aurora 2 gesture tests on an emulated touch iPhone, driven with real CDP touch
// events (so touch + pointer handlers fire exactly as on a phone).
// Usage: AURORA_TOKEN=… node gestures.mjs [outDir]
import { chromium } from 'playwright';

import fs from 'node:fs';
const OUT = process.argv[2] || new URL('./out', import.meta.url).pathname;
const TOKEN = process.env.AURORA_TOKEN;
const BASE = process.env.AURORA_URL || 'http://127.0.0.1:8091';
fs.mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const ok = (name, cond, extra) => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

if (!TOKEN) { console.error('Set AURORA_TOKEN (dev-server.sh prints it)'); process.exit(2); }
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await ctx.addCookies([{ name: 'aurora_sid', value: TOKEN, url: BASE }]);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
const cdp = await ctx.newCDPSession(page);
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); };

async function touch(type, points) { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })) }); }
async function drag(from, to, steps = 12, holdMs = 0) {
  await touch('touchStart', [from]);
  if (holdMs) await wait(holdMs);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
    await wait(16);
  }
  await touch('touchEnd', []);
}
async function tap(p) { await touch('touchStart', [p]); await wait(40); await touch('touchEnd', []); }
async function pinch(center, d0, d1, steps = 10) {
  const pts = (d) => [{ x: center.x - d / 2, y: center.y }, { x: center.x + d / 2, y: center.y }];
  await touch('touchStart', pts(d0));
  for (let i = 1; i <= steps; i++) { await touch('touchMove', pts(d0 + (d1 - d0) * i / steps)); await wait(20); }
  await touch('touchEnd', []);
}
const rectOf = (sel, i = 0) => ev(([s, i]) => { const el = document.querySelectorAll(s)[i]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }, [sel, i]);

await page.goto(`${BASE}/aurora`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('#photoGrid .tile img').length > 8, null, { timeout: 25000 });
await wait(1500);

// ── Grid pinch changes the column count ──
const cols0 = await ev(() => libGrid.cols);
await pinch({ x: 196, y: 500 }, 260, 60);
await wait(400);
const cols1 = await ev(() => libGrid.cols);
await pinch({ x: 196, y: 500 }, 60, 300);
await wait(400);
const cols2 = await ev(() => libGrid.cols);
ok('pinch in → more columns', cols1 > cols0, `${cols0} → ${cols1}`);
ok('pinch out → fewer columns', cols2 < cols1, `${cols1} → ${cols2}`);
await ev(() => setGridZoom(1));
await wait(300);

// ── Tap a PHOTO tile opens the viewer with chrome ──
const photoIdx = await ev(() => libGrid.items.findIndex((it, i) => i > 2 && it.kind === 'photo' && !it.live_video_id));
await ev((i) => libGrid.scrollToIndex(i), photoIdx);
await wait(400);
const tileR = await ev((i) => { const r = libGrid.tileRect(i); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, photoIdx);
await tap(tileR);
await wait(900);
ok('tap tile opens viewer', await ev(() => document.getElementById('lightbox').classList.contains('open')));
ok('viewer shows the tapped item', await ev((i) => state.lightboxIdx === i, photoIdx));
await shot('g01-viewer-photo');

// ── Swipe left → next item ──
const before = await ev(() => state.lightboxIdx);
await drag({ x: 300, y: 420 }, { x: 60, y: 430 }, 10);
await wait(600);
ok('swipe left pages forward', await ev((b) => state.lightboxIdx === b + 1, before), `idx ${before} → ${await ev(() => state.lightboxIdx)}`);
await drag({ x: 60, y: 420 }, { x: 320, y: 410 }, 10);
await wait(600);
ok('swipe right pages back', await ev((b) => state.lightboxIdx === b, before));

// ── Tap toggles chrome ──
await tap({ x: 196, y: 420 });
await wait(450);
ok('tap hides chrome', await ev(() => document.getElementById('lightbox').classList.contains('chrome-hidden')));
await tap({ x: 196, y: 420 });
await wait(450);
ok('tap shows chrome', await ev(() => !document.getElementById('lightbox').classList.contains('chrome-hidden')));

// ── Double-tap zooms ──
await tap({ x: 196, y: 420 }); await wait(90); await tap({ x: 196, y: 420 });
await wait(400);
ok('double-tap zooms in', await ev(() => lbZoom.scale > 1.5), 'scale ' + await ev(() => lbZoom.scale));
await tap({ x: 196, y: 420 }); await wait(90); await tap({ x: 196, y: 420 });
await wait(400);
ok('double-tap zooms out', await ev(() => lbZoom.scale === 1));

// ── Swipe up opens Info; swipe down on photo closes Info ──
await drag({ x: 196, y: 600 }, { x: 196, y: 420 }, 8);
await wait(700);
ok('swipe up opens info', await ev(() => document.getElementById('metaPanel').classList.contains('open')));
await shot('g02-info');
await drag({ x: 196, y: 150 }, { x: 196, y: 320 }, 8);
await wait(600);
ok('swipe down closes info', await ev(() => !document.getElementById('metaPanel').classList.contains('open')));

// ── Filmstrip scrub ──
const filmBefore = await ev(() => state.lightboxIdx);
await ev(() => { const f = document.getElementById('lbFilm'); f.scrollLeft += 32 * 3; });
await wait(700);
ok('filmstrip scroll changes photo', await ev((b) => state.lightboxIdx === b + 3, filmBefore), `${filmBefore} → ${await ev(() => state.lightboxIdx)}`);

// ── Swipe down closes the viewer ──
await drag({ x: 196, y: 300 }, { x: 210, y: 600 }, 10);
await wait(700);
ok('swipe down closes viewer', await ev(() => !document.getElementById('lightbox').classList.contains('open')));

// ── Long-press → context menu ──
const t2 = await rectOf('#photoGrid .tile', 6);
await touch('touchStart', [t2]); await wait(650); await touch('touchEnd', []);
await wait(300);
ok('long-press opens context menu', await ev(() => !!document.querySelector('.menu')));
await shot('g03-context-menu');
await ev(() => closeMenus());
await wait(200);
ok('long-press did not open viewer', await ev(() => !document.getElementById('lightbox').classList.contains('open')));

// ── Select mode: tap + horizontal sweep ──
await ev(() => toggleSelectMode());
await wait(300);
const a = await rectOf('#photoGrid .tile', 4), b = await rectOf('#photoGrid .tile', 7);
await tap(a);
await wait(200);
ok('select: tap selects one', await ev(() => state.selected.size === 1));
await tap(a);
await wait(200);
ok('select: tap again deselects', await ev(() => state.selected.size === 0));
await drag({ x: a.x - 30, y: a.y }, { x: b.x, y: b.y }, 12);
await wait(300);
const nSel = await ev(() => state.selected.size);
ok('select: sideways sweep selects a run', nSel >= 3, `${nSel} selected`);
await shot('g04-select-sweep');
// Vertical drag in select mode should scroll, not select
const stBefore = await ev(() => document.getElementById('libScroll').scrollTop);
const sBefore = await ev(() => state.selected.size);
await drag({ x: 300, y: 700 }, { x: 300, y: 300 }, 10);
await wait(400);
const stAfter = await ev(() => document.getElementById('libScroll').scrollTop);
ok('select: vertical drag scrolls', stAfter > stBefore + 50 && await ev((s) => state.selected.size === s, sBefore), `scrollTop ${stBefore} → ${stAfter}`);
await ev(() => exitSelectMode());

// ── Scroll hides chrome; scroll up reveals ──
await ev(() => document.getElementById('libScroll').scrollTo(0, 0));
await wait(200);
for (let i = 0; i < 4; i++) { await drag({ x: 200, y: 700 }, { x: 200, y: 250 }, 6); await wait(120); }
await wait(400);
ok('scrolling down minimises chrome', await ev(() => document.getElementById('screen-library').classList.contains('chrome-min') && document.getElementById('tabbar').classList.contains('min')));
await shot('g05-scrolled-min');
for (let i = 0; i < 2; i++) { await drag({ x: 200, y: 250 }, { x: 200, y: 700 }, 6); await wait(120); }
await wait(400);
ok('scrolling up restores chrome', await ev(() => !document.getElementById('screen-library').classList.contains('chrome-min')));

// ── Scrubber drag ──
await drag({ x: 200, y: 700 }, { x: 200, y: 400 }, 4);   // show it
await wait(200);
const scrubR = await rectOf('#scrubHandle');
const yBefore = await ev(() => document.getElementById('libScroll').scrollTop);
await drag({ x: scrubR.x, y: scrubR.y }, { x: scrubR.x, y: scrubR.y + 300 }, 15);
await wait(300);
const yAfter = await ev(() => document.getElementById('libScroll').scrollTop);
ok('scrubber drag jumps far', yAfter - yBefore > 20000, `scrollTop ${Math.round(yBefore)} → ${Math.round(yAfter)}`);

// ── Search paging ──
await ev(() => switchScreen('search'));
await wait(600);
await page.fill('#searchInput', 'beach');
await page.press('#searchInput', 'Enter');
await page.waitForFunction(() => searchGrid.items.length > 0, null, { timeout: 15000 });
const n0 = await ev(() => searchGrid.items.length);
for (let i = 0; i < 30; i++) { await ev(() => { const s = document.getElementById('searchResults'); s.scrollTop = s.scrollHeight; }); await wait(150); }
await wait(800);
const n1 = await ev(() => searchGrid.items.length);
ok('search pages in more results', n1 > n0, `${n0} → ${n1} (total ${await ev(() => searchMeta.total)})`);
ok('search token rendered', await ev(() => document.querySelectorAll('#searchChips .token').length === 1));

// ── Places: pin tap → sheet; swipe down closes ──
await ev(() => switchScreen('places'));
await page.waitForFunction(() => document.querySelectorAll('.ppin').length > 0, null, { timeout: 15000 });
await wait(800);
const pin = await rectOf('.ppin .ph');
await tap(pin);
await wait(1500);
ok('pin tap opens place sheet', await ev(() => document.getElementById('placeDetail').classList.contains('open')));
await shot('g06-place-sheet');
const grab = await rectOf('#placeSheetGrab');
await drag({ x: grab.x, y: grab.y }, { x: grab.x, y: grab.y + 260 }, 8);
await wait(600);
ok('drag sheet down closes it', await ev(() => !document.getElementById('placeDetail').classList.contains('open')));
// Map pan moves pins without rebuilding them
const pinsBefore = await ev(() => [...document.querySelectorAll('.ppin')].map(p => p.style.transform).join('|'));
const elBefore = await ev(() => document.querySelector('.ppin'));
await drag({ x: 100, y: 400 }, { x: 180, y: 430 }, 8);
await wait(300);
ok('pan moves pins', await ev((b) => [...document.querySelectorAll('.ppin')].map(p => p.style.transform).join('|') !== b, pinsBefore));

// ── Collections: create album, open, rename via API helpers, delete ──
await ev(() => switchScreen('collections'));
await wait(1500);
const created = await ev(async () => { const r = await postJSON('/api/aurora/albums', { name: 'UI test album' }); await postJSON(`/api/aurora/albums/${r.id}/assets`, { add: libGrid.items.slice(0, 6).map(i => i.id) }); return r.id; });
await ev(() => loadCollections(true));
await wait(1200);
await ev((id) => openAlbumDetail(id), created);
await wait(1500);
ok('album detail open', await ev(() => detailIsOpen() && detailGrid.items.length === 6));
await shot('g07-album');
// Edge swipe back closes the detail
await drag({ x: 8, y: 400 }, { x: 300, y: 410 }, 10);
await wait(600);
ok('edge swipe back closes detail', await ev(() => !detailIsOpen()));
await ev((id) => postJSON(`/api/aurora/albums/${id}/delete`, {}), created);

// ── Account sheet: drag down dismisses ──
await ev(() => openAccountSheet());
await wait(600);
const ag = await rectOf('#accountSheet .sheet-grab-area');
await drag({ x: ag.x, y: ag.y }, { x: ag.x, y: ag.y + 300 }, 8);
await wait(600);
ok('account sheet drag-dismiss', await ev(() => !document.getElementById('accountSheet').classList.contains('open')));

// ── Settings: push + edge-swipe pop ──
await ev(() => openSettings());
await wait(500);
await ev(() => openSettingsPage('users'));
await wait(700);
ok('settings push', await ev(() => settingsNav.stack.join('/') === 'root/users'));
await drag({ x: 8, y: 400 }, { x: 300, y: 410 }, 10);
await wait(600);
ok('settings edge-swipe pops', await ev(() => settingsNav.stack.join('/') === 'root'));
await ev(() => closeSettings());

// ── Themes render ──
for (const t of ['light', 'dark', 'purple']) {
  await ev((t) => applyTheme(t), t);
  await ev(() => switchScreen('collections'));
  await wait(500);
  await shot('g08-theme-' + t);
}

console.log(results.join('\n'));
console.log('ERRORS', JSON.stringify(errors, null, 1));
await browser.close();
