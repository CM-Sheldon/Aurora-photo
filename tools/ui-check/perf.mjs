// Aurora 2 scroll perf on an emulated iPhone: long-task blocking, DOM size,
// running animations while flinging the Library, Search results and a detail.
import { chromium } from 'playwright';
const TOKEN = process.env.AURORA_TOKEN;
const BASE = process.env.AURORA_URL || 'http://127.0.0.1:8091';
if (!TOKEN) { console.error('Set AURORA_TOKEN (dev-server.sh prints it)'); process.exit(2); }
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await ctx.addCookies([{ name: 'aurora_sid', value: TOKEN, url: BASE }]);
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__lt = { count: 0, blocking: 0, max: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__lt.count++; window.__lt.blocking += Math.max(0, e.duration - 50); window.__lt.max = Math.max(window.__lt.max, e.duration); } }).observe({ entryTypes: ['longtask'] }); } catch (_) {}
});
const t0 = Date.now();
await page.goto(`${BASE}/aurora`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('#photoGrid .tile img').length > 8, null, { timeout: 30000 });
console.log('first grid paint ms', Date.now() - t0);
await page.waitForTimeout(1500);
const reset = () => page.evaluate(() => { window.__lt.count = 0; window.__lt.blocking = 0; window.__lt.max = 0; });
const stats = (label) => page.evaluate((label) => ({
  label, tiles: document.querySelectorAll('.tile').length, nodes: document.getElementsByTagName('*').length,
  anims: document.getAnimations ? document.getAnimations().length : -1,
  longTasks: window.__lt.count, blockingMs: Math.round(window.__lt.blocking), maxTaskMs: Math.round(window.__lt.max),
}), label);
async function fling(sel, steps, dy) {
  for (let i = 0; i < steps; i++) { await page.evaluate(([s, d]) => document.querySelector(s).scrollBy(0, d), [sel, dy]); await page.waitForTimeout(16); }
  await page.waitForTimeout(500);
}
await reset(); await fling('#libScroll', 120, 900); console.log(JSON.stringify(await stats('library fling 108k px')));
await reset(); await page.evaluate(() => setLibView('months')); await page.waitForTimeout(800); await fling('#libScroll', 60, 900); console.log(JSON.stringify(await stats('months view fling')));
await page.evaluate(() => setLibView('all'));
await reset(); await page.evaluate(() => { switchScreen('search'); }); await page.fill('#searchInput', 'beach'); await page.press('#searchInput', 'Enter');
await page.waitForFunction(() => searchGrid.items.length > 0); await fling('#searchResults', 80, 900); console.log(JSON.stringify(await stats('search fling + paging')));
await reset(); await page.evaluate(() => switchScreen('places')); await page.waitForTimeout(2500); console.log(JSON.stringify(await stats('places load')));
await reset(); await page.evaluate(() => switchScreen('collections')); await page.waitForTimeout(2500); console.log(JSON.stringify(await stats('collections load')));
await browser.close();
