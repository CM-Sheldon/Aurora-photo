/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — boot.js
   Debug perf HUD, service-worker registration, and the boot sequence.
   Loaded last: every other module's globals exist by now.
   ════════════════════════════════════════════════════════════════════════ */

// ── Debug perf HUD: open the app with ?debug=1 (persists), ?debug=0 to stop.
// Shows build, fps, DOM tile/video counts, Live previews spawned, running
// animations, heap and long-task blocking — enough to diagnose on-device jank.
(function () {
  try {
    const p = new URLSearchParams(location.search).get('debug');
    if (p === '1') localStorage.setItem('aurora_debug', '1');
    if (p === '0') localStorage.removeItem('aurora_debug');
    if (localStorage.getItem('aurora_debug') !== '1') return;
  } catch (_) { return; }
  const hud = $('perfHud');
  hud.style.display = 'block';
  let frames = 0, last = performance.now(), fps = 0, minFps = 999;
  (function loop(now) {
    frames++;
    if (now - last >= 500) { fps = Math.round((frames * 1000) / (now - last)); if (fps < minFps) minFps = fps; frames = 0; last = now; }
    requestAnimationFrame(loop);
  })(performance.now());
  let longTasks = 0, blockingMs = 0;
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { longTasks++; blockingMs += Math.max(0, e.duration - 50); } }).observe({ entryTypes: ['longtask'] });
  } catch (_) {}
  window.__resetPerf = () => { minFps = 999; longTasks = 0; blockingMs = 0; window.__auroraPerf.previewsCreated = 0; };
  const cls = (v, warn, bad) => v >= bad ? 'bad' : v >= warn ? 'warn' : '';
  setInterval(() => {
    const tiles = document.querySelectorAll('.tile').length;
    const vids = document.querySelectorAll('video').length;
    const previews = document.querySelectorAll('video.tile-live-preview').length;
    let anims = '—'; try { if (document.getAnimations) anims = document.getAnimations().length; } catch (_) {}
    const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'M' : 'n/a';
    const pf = window.__auroraPerf;
    hud.innerHTML =
      `<b>${escapeHtml(pf.build)}</b>\n` +
      `screen   ${state.screen}${document.documentElement.classList.contains('no-blur') ? '  (no-blur)' : ''}\n` +
      `fps      <span class="${fps < 30 ? 'bad' : fps < 50 ? 'warn' : ''}">${fps}</span>  (min ${minFps === 999 ? '—' : minFps})\n` +
      `tiles    ${tiles}   zoom ${GRID_ZOOM.level}\n` +
      `videos   <span class="${cls(vids, 2, 5)}">${vids}</span>  (preview ${previews})\n` +
      `previews spawned: <span class="${cls(pf.previewsCreated, 1, 5)}">${pf.previewsCreated}</span>\n` +
      `ptrType  ${pf.lastPointerType}\n` +
      `anims    <span class="${typeof anims === 'number' ? cls(anims, 40, 120) : ''}">${anims}</span>\n` +
      `heap     ${heap}\n` +
      `longtask ${longTasks}  block ${Math.round(blockingMs)}ms`;
  }, 500);
})();

// ── PWA: service worker (network-first shell; see /aurora-sw.js) ──────────
if ('serviceWorker' in navigator) {
  // When a NEW worker replaces an old one after a deploy, reload once onto it.
  // (A device's very first visit has no previous worker — no reload needed.)
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded || !hadController) return; reloaded = true; location.reload(); });
  window.addEventListener('load', () => { navigator.serviceWorker.register('/aurora-sw.js', { scope: '/aurora' }).catch(() => {}); });
}

// ── Boot ──────────────────────────────────────────────────────────────────
(async () => {
  switchScreen('library', { noAnim: true });
  await loadMe();
  checkPendingUpdate();
  await Promise.all([loadStats(), loadIndex()]);
  // Header height can change once fonts/avatars settle — re-measure the inset.
  setTimeout(() => libGrid.relayout(), 300);
})();
