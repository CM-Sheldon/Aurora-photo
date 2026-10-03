// ── Build + perf instrumentation ──────────────────────────────────────────
// PAGE_BUILD is the build baked into THIS html at render time (from
// version.json). Compared on boot against the never-cached /api/aurora/version
// to detect a stale service-worker copy. Bump version.json on every deploy.
const PAGE_VERSION = (window.AURORA_BOOT && window.AURORA_BOOT.version) || 'dev';
const PAGE_BUILD = (window.AURORA_BOOT && window.AURORA_BOOT.build) || 'dev';
const AURORA_BUILD = PAGE_VERSION + ' · ' + PAGE_BUILD;
window.__auroraPerf = { build: AURORA_BUILD, previewsCreated: 0, lastPointerType: '—' };
console.log('[Aurora] page build', AURORA_BUILD);

// Stale-build detector: if the live server build differs from what's baked
// into this (possibly cached) page, the SW served an old copy — surface a
// reload banner. We also poll every 60s and on visibilitychange so a tab
// that was open BEFORE the in-app updater ran flips over to the new
// version on its own instead of quietly staying on stale code.
async function checkServerBuild() {
  try {
    const srv = await fetch('/api/aurora/version', { cache: 'no-store' }).then(r => r.json());
    if (srv && srv.build && srv.build !== PAGE_BUILD) {
      console.warn('[Aurora] stale page', PAGE_BUILD, '→ server', srv.build);
      showUpdateBanner(srv);
    }
  } catch (_) {}
}
checkServerBuild();
setInterval(checkServerBuild, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkServerBuild();
});
function showUpdateBanner(srv) {
  if (document.getElementById('updateBanner')) return;
  const b = document.createElement('div');
  b.id = 'updateBanner';
  b.innerHTML = `<span>New version available (${srv.version} · ${srv.build})</span>` +
    `<button onclick="hardReload()">Reload</button>`;
  document.body.appendChild(b);
}
async function hardReload() {
  try {
    if ('caches' in window) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); }
    if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); }
  } catch (_) {}
  location.reload(true);
}

// ── State ──
const state = {
  assets: [],       // full lightweight index
  filtered: [],     // after sliders/tabs
  timeMin: 0, timeMax: 0,
  monthBase: 0, totalMonths: 1, fromMonth: 0, toMonth: 0,
  tileSize: 180,
  kindFilter: 'all',
  lightboxIdx: -1,
  lightboxItems: [],
  placeSelection: null,
  placesFrom: 0, placesTo: 0,   // Places-map time-range slider (month indices)
  metaAssetId: null,
  selectMode: false,
  selected: new Set(),   // selected asset ids (multi-select)
  selectList: [],        // items currently shown in the active grid (for "select all")
  importSessionId: null,
  importSSE: null,
  hideRaw: (() => { try { return localStorage.getItem('aurora_hideRaw') === '1'; } catch (_) { return false; } })(),
  privateUnlocked: false,  // true after correct passcode entered this session
  hiddenMode: false,        // true when browsing the hidden album
  assetsLoaded: false,      // true after loadIndex() completes
};

// ── Screen routing ──
function switchScreen(id) {
  if (id === 'import') id = 'settings'; // Import is now a section of Settings
  if (state.selectMode) exitSelectMode();
  // Leaving search clears hidden mode
  if (id !== 'search' && state.hiddenMode) {
    state.hiddenMode = false;
    document.getElementById('hiddenBanner').style.display = 'none';
    document.querySelector('.search-sidebar').style.display = '';
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item, .bnav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
  document.querySelectorAll(`[data-screen="${id}"]`).forEach(n => n.classList.add('active'));
  if (id === 'library') renderGrid();
  if (id === 'places') loadPlaces();
  if (id === 'search') loadSearch();
  if (id === 'albums') loadAlbums();
  if (id === 'settings') { loadSettings(); startWarmPoll(); }
}
document.querySelectorAll('.nav-item, .bnav-item').forEach(item => {
  item.addEventListener('click', () => switchScreen(item.dataset.screen));
});

// ── Toast ──
function toast(msg, dur = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

// ── Button feedback ──
// Gives any button instant "something is happening" feedback: disabled with a
// spinner + label while the action runs. Returns a `done(label)` to restore it
// (optionally flashing a result label briefly before reverting).
function btnBusy(btn, busyLabel) {
  if (!btn) return () => {};
  if (btn.dataset.busy === '1') return () => {}; // already running
  const orig = btn.dataset.origHtml || btn.innerHTML;
  btn.dataset.origHtml = orig;
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.innerHTML = `<span class="spin-dot"></span>${busyLabel || 'Working…'}`;
  return (doneLabel) => {
    btn.dataset.busy = '0';
    btn.disabled = false;
    if (doneLabel) {
      btn.innerHTML = doneLabel;
      setTimeout(() => { if (btn.dataset.busy !== '1') btn.innerHTML = orig; }, 1800);
    } else {
      btn.innerHTML = orig;
    }
  };
}
// Status line setter shared by the Settings action cards.
function setActionStatus(msg, kind) {
  const s = document.getElementById('settingsActionStatus');
  if (!s) return;
  s.textContent = msg || '';
  s.style.color = kind === 'err' ? '#f87171' : kind === 'ok' ? '#4ade80' : 'var(--text-muted)';
}

// ── Utilities ──
function fmtBytes(b) {
  if (!b) return '—';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0; let v = b;
  while (v > 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + u[i];
}
function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function fmtYear(ms) { return ms ? new Date(ms).getFullYear() : null; }
function fmtMon(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { month:'long', year:'numeric' });
}
function fmtMonShort(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { month:'short', year:'numeric' });
}
// Month-precision helpers for the time-range slider (local time, matching fmtMon).
function startOfMonth(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
function addMonths(ms, n) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); }
function monthIndexOf(ms) { const b = new Date(state.monthBase || ms), d = new Date(ms); return (d.getFullYear() - b.getFullYear()) * 12 + (d.getMonth() - b.getMonth()); }
function fmtDuration(s) {
  if (!s) return null;
  s = Math.round(s);
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2,'0')}`;
}
// Cache epoch (latest import time) busts stale browser-cached thumbnails after
// a re-import reassigns asset ids — see the /aurora route in server.js.
const CACHE_EPOCH = (window.AURORA_BOOT && window.AURORA_BOOT.cacheEpoch) || '0';
function thumbUrl(id, size='grid') { return `/api/aurora/thumb/${id}?size=${size}&v=${CACHE_EPOCH}`; }

// ── Load stats ──
async function loadStats() {
  try {
    const s = await fetch('/api/aurora/stats').then(r => r.json());
    document.getElementById('statPhotos').textContent = (s.photos || 0).toLocaleString();
    document.getElementById('statVideos').textContent = (s.videos || 0).toLocaleString();
    document.getElementById('statPlaces').textContent = (s.place_count || 0).toLocaleString();
    document.getElementById('statStorage').textContent = fmtBytes(s.total_bytes);
    document.getElementById('navBadgeLibrary').textContent = (s.total || 0).toLocaleString();
  } catch(_) {}
}

// ── Load index ──
async function loadIndex() {
  try {
    const raw = await fetch('/api/aurora/assets/index' + (state.hideRaw ? '?hideRaw=1' : ''));
    const data = await raw.json().catch(() => []);
    // Map compact wire fields (t,k,f,lv) back to full names used across the UI
    state.assets = data.map(r => ({ id: r.id, taken_at: r.t, kind: r.k, fav: r.f, live_video_id: r.lv }));
    // We now have a definitive answer (possibly empty) — set before any early
    // return so computeGridLayout() shows the real empty state, not a blank
    // screen, and the boot spinner is dismissed.
    state.assetsLoaded = true;
    if (!state.assets.length) { renderGrid(); return; }

    // NOTE: never Math.min(...bigArray) — spreading 100K+ items overflows the
    // call stack. Compute min/max with a single pass instead.
    let lo = Infinity, hi = -Infinity;
    for (const a of state.assets) {
      if (!a.taken_at) continue;
      if (a.taken_at < lo) lo = a.taken_at;
      if (a.taken_at > hi) hi = a.taken_at;
    }
    state.timeMin = lo === Infinity ? 0 : lo;
    state.timeMax = hi === -Infinity ? 0 : hi;

    // Set up the month-precision time slider over the library's date span.
    const anchor = state.timeMin || Date.now();
    state.monthBase = startOfMonth(anchor);
    state.totalMonths = Math.max(1, monthIndexOf(state.timeMax || anchor) + 1);
    state.fromMonth = 0;
    state.toMonth = state.totalMonths - 1;
    timeFrom.min = timeTo.min = 0;
    timeFrom.max = timeTo.max = state.totalMonths - 1;
    timeFrom.value = 0; timeTo.value = state.totalMonths - 1;
    updateTimeLabel();

    buildHistogram();
    buildRangeTicks();
    applyFilters();
  } catch(_) {
    // Network/parse failure — dismiss the spinner and fall back to the empty
    // state rather than leaving the boot spinner forever.
    state.assetsLoaded = true;
    renderGrid();
  }
}

// ── Histogram ──
// buildHistogram() creates the bars once. updateHistogramRange() only toggles
// the in-range class — no DOM rebuild — so dragging the slider never causes
// a layout shift that makes the thumb jump.
function buildHistogram() {
  const el = document.getElementById('histogram');
  el.innerHTML = '';
  if (!state.assets.length) return;

  const BUCKETS = 40;
  const span = state.timeMax - state.timeMin || 1;
  const counts = new Array(BUCKETS).fill(0);
  for (const a of state.assets) {
    if (!a.taken_at) continue;
    const idx = Math.min(BUCKETS - 1, Math.floor(((a.taken_at - state.timeMin) / span) * BUCKETS));
    counts[idx]++;
  }
  const max = Math.max(...counts, 1);
  counts.forEach((c) => {
    const bar = document.createElement('div');
    bar.className = 'hist-bar';
    bar.style.height = Math.max(2, (c / max) * 28) + 'px';
    el.appendChild(bar);
  });
  updateHistogramRange();
}

function updateHistogramRange() {
  const bars = document.querySelectorAll('#histogram .hist-bar');
  if (!bars.length) return;
  const BUCKETS = bars.length;
  const total = state.totalMonths || 1;
  const fromI = Math.floor((state.fromMonth / total) * BUCKETS);
  const toI = Math.min(BUCKETS - 1, Math.ceil(((state.toMonth + 1) / total) * BUCKETS) - 1);
  bars.forEach((bar, i) => bar.classList.toggle('in-range', i >= fromI && i <= toI));
}

// ── Filters ──
function applyFilters() {
  const from = addMonths(state.monthBase, state.fromMonth);
  const to = addMonths(state.monthBase, state.toMonth + 1) - 1;
  const fullRange = state.fromMonth <= 0 && state.toMonth >= state.totalMonths - 1;

  state.filtered = state.assets.filter(a => {
    if (state.kindFilter === 'photo' && a.kind !== 'photo') return false;
    if (state.kindFilter === 'video' && a.kind !== 'video') return false;
    if (state.kindFilter === 'fav' && !a.fav) return false;
    // Undated items have no month to fall in — show them only at full range,
    // so narrowing the slider doesn't keep dragging in thousands of undated photos.
    if (!a.taken_at) return fullRange;
    if (a.taken_at < from || a.taken_at > to) return false;
    return true;
  });

  document.getElementById('libraryCount').textContent = state.filtered.length.toLocaleString() + ' items';
  updateHistogramRange();
  renderGrid();
}

// ── Virtualized grid ──
// Only the tiles near the viewport exist in the DOM at any time, so the
// library stays fluid whether it holds 100 items or 200,000.
const vgrid = {
  cols: 0, cellW: 0, rowH: 0, gap: 4, headerH: 38,
  rendered: new Map(),   // global item index → tile element
  headers: new Map(),    // month-group key → header element
  groups: [],            // [{ key, label, startIdx, count, headerY, firstRowY, rows, endY }]
  totalHeight: 0,
  rafPending: false,
  lastScrollTop: 0,
  topInset: 0,           // px reserved at the top for the overlay chrome
};
function monthKeyOf(ms) { if (!ms) return 'unknown'; const d = new Date(ms); return d.getFullYear() + '-' + d.getMonth(); }

function renderGrid() {
  // Library uses the virtualized renderer. Reset existing tiles since the
  // filtered set (and therefore index→item mapping) may have changed.
  state.lightboxItems = state.filtered;
  state.selectList = state.filtered;
  const grid = document.getElementById('photoGrid');
  grid.innerHTML = '';
  vgrid.rendered.clear();
  vgrid.headers.clear();
  const wrap = document.getElementById('photoGridWrap');
  wrap.scrollTop = 0; // jump to top on filter change
  vgrid.lastScrollTop = 0;
  // Jumping to the top means the chrome should be shown; reset the scroll
  // tracker so the next real scroll computes a sane delta.
  if (typeof libChrome !== 'undefined') { libChrome.lastY = 0; libChrome.upAccum = 0; setLibChrome(false); }
  computeGridLayout();
  paintWindow(true);
}

// Measure the overlay chrome's height and expose it as --lib-inset so the grid
// reserves matching top space (its first row sits below the bar; content then
// scrolls under it). offsetHeight is unaffected by the collapse transform, so
// this stays constant while hiding/showing — that's what keeps the gallery from
// reflowing. +6px of breathing room below the bar.
function updateLibInset() {
  const chrome = document.getElementById('libChrome');
  const screen = document.getElementById('screen-library');
  if (!chrome || !screen) return;
  const h = chrome.offsetHeight;
  if (h > 0) { vgrid.topInset = h + 6; screen.style.setProperty('--lib-inset', vgrid.topInset + 'px'); }
}

function computeGridLayout() {
  updateLibInset();
  const wrap = document.getElementById('photoGridWrap');
  const grid = document.getElementById('photoGrid');
  const empty = document.getElementById('libraryEmpty');
  const loading = document.getElementById('libraryLoading');
  if (loading) loading.style.display = 'none';

  if (!state.filtered.length) {
    grid.innerHTML = '';
    grid.style.height = '0px';
    vgrid.rendered.clear(); vgrid.headers.clear(); vgrid.groups = [];
    if (state.assetsLoaded) empty.style.display = 'flex';
    document.getElementById('floatingMonth').classList.remove('show');
    return;
  }
  empty.style.display = 'none';

  // Measure the real content width from the grid element so padding (which
  // differs between desktop and mobile) is accounted for automatically.
  const contentW = grid.clientWidth || (wrap.clientWidth - 40);
  const isMobile = window.matchMedia('(max-width: 760px)').matches;

  let cols;
  if (isMobile) {
    cols = contentW < 360 ? 3 : contentW < 560 ? 4 : 5;
  } else {
    cols = Math.max(1, Math.floor((contentW + vgrid.gap) / (state.tileSize + vgrid.gap)));
  }

  vgrid.cols = Math.max(1, cols);
  vgrid.cellW = Math.floor((contentW - (vgrid.cols - 1) * vgrid.gap) / vgrid.cols);
  vgrid.rowH = vgrid.cellW + vgrid.gap;
  vgrid.headerH = isMobile ? 34 : 40;

  // Group consecutive items by month (state.filtered is date-desc, so each
  // month is a contiguous run) and stack groups, each preceded by a header.
  const groups = [];
  let cur = null;
  for (let i = 0; i < state.filtered.length; i++) {
    const a = state.filtered[i];
    const key = monthKeyOf(a.taken_at);
    if (!cur || cur.key !== key) {
      cur = { key, label: a.taken_at ? fmtMon(a.taken_at) : 'Unknown date', startIdx: i, count: 0 };
      groups.push(cur);
    }
    cur.count++;
  }
  let y = 0;
  for (const g of groups) {
    g.headerY = y;
    y += vgrid.headerH;
    g.firstRowY = y;
    g.rows = Math.ceil(g.count / vgrid.cols);
    y += g.rows * vgrid.rowH;
    g.endY = y;
    y += 10; // breathing room before the next month
  }
  vgrid.groups = groups;
  vgrid.totalHeight = y;
  grid.style.height = y + 'px';
}

function paintWindow() {
  const wrap = document.getElementById('photoGridWrap');
  const grid = document.getElementById('photoGrid');
  if (!state.filtered.length || !vgrid.groups.length) return;

  const scrollTop = wrap.scrollTop;
  const viewH = wrap.clientHeight;
  const { cols, cellW, rowH, gap, headerH } = vgrid;

  // Prefetch more aggressively in the scroll direction so upcoming thumbnails
  // are already loading before they reach the viewport.
  const dir = scrollTop >= vgrid.lastScrollTop ? 1 : -1;
  vgrid.lastScrollTop = scrollTop;
  const aheadPx = viewH * 1.6, behindPx = viewH * 0.7;
  const top = scrollTop - (dir > 0 ? behindPx : aheadPx);
  const bot = scrollTop + viewH + (dir > 0 ? aheadPx : behindPx);

  const wantTiles = new Set();
  const wantHeaders = new Set();
  let topLabel = null;

  for (const g of vgrid.groups) {
    if (g.endY < top || g.headerY > bot) continue;     // group fully outside window
    wantHeaders.add(g.key);
    if (!vgrid.headers.has(g.key)) {
      const h = document.createElement('div');
      h.className = 'month-break';
      h.style.top = g.headerY + 'px';
      h.style.height = headerH + 'px';
      h.innerHTML = `<span class="mb-label">${escapeHtml(g.label)}</span><span class="mb-count">${g.count.toLocaleString()}</span>`;
      grid.appendChild(h);
      vgrid.headers.set(g.key, h);
    }
    const rTop = Math.max(0, Math.floor((top - g.firstRowY) / rowH));
    const rBot = Math.min(g.rows - 1, Math.floor((bot - g.firstRowY) / rowH));
    for (let r = rTop; r <= rBot; r++) {
      const base = g.startIdx + r * cols;
      for (let c = 0; c < cols; c++) {
        const idx = base + c;
        if (idx >= g.startIdx + g.count) break;
        wantTiles.add(idx);
        if (!vgrid.rendered.has(idx)) {
          const tile = makeTile(state.filtered[idx], idx, true); // immediate=true → prefetch thumb now
          tile.style.left = (c * (cellW + gap)) + 'px';
          tile.style.top = (g.firstRowY + r * rowH) + 'px';
          tile.style.width = cellW + 'px';
          tile.style.height = cellW + 'px';
          grid.appendChild(tile);
          vgrid.rendered.set(idx, tile);
        }
      }
    }
    if (topLabel === null && g.endY > scrollTop + 4) topLabel = g.label;
  }

  // Recycle anything no longer in the window
  for (const [idx, el] of vgrid.rendered) if (!wantTiles.has(idx)) { el.remove(); vgrid.rendered.delete(idx); }
  for (const [key, el] of vgrid.headers) if (!wantHeaders.has(key)) { el.remove(); vgrid.headers.delete(key); }

  const fm = document.getElementById('floatingMonth');
  if (topLabel) { fm.textContent = topLabel; fm.classList.add('show'); }
  else fm.classList.remove('show');
}

// Scroll handler — throttled to one paint per animation frame
document.getElementById('photoGridWrap').addEventListener('scroll', () => {
  updateLibChrome();
  if (vgrid.rafPending) return;
  vgrid.rafPending = true;
  requestAnimationFrame(() => {
    vgrid.rafPending = false;
    if (document.getElementById('screen-library').classList.contains('active')) {
      paintWindow();
    }
  });
});

// ── Auto-hiding library chrome ──
// Collapse the toolbar + time-range on scroll-down to maximise gallery space.
// Revealing again needs a deliberate scroll UP — you must scroll up past a few
// rows' worth of distance (upAccum threshold) so a small nudge or the natural
// jitter at the end of a fling doesn't flick the toolbar back. Any downward
// scroll re-collapses and resets the accumulator.
const libChrome = { lastY: 0, collapsed: false, upAccum: 0 };
function setLibChrome(collapsed) {
  if (libChrome.collapsed === collapsed) return;
  libChrome.collapsed = collapsed;
  document.getElementById('screen-library').classList.toggle('chrome-min', collapsed);
}
function updateLibChrome() {
  const wrap = document.getElementById('photoGridWrap');
  const y = wrap.scrollTop;
  const dy = y - libChrome.lastY;
  libChrome.lastY = y;
  // Only hide once the content has scrolled past the bar's own height — below
  // that the bar still overlaps the first rows, so hiding it would reveal an
  // empty strip. Above it, always keep the bar shown.
  const inset = vgrid.topInset || 140;
  if (y < inset) { libChrome.upAccum = 0; setLibChrome(false); return; }
  if (dy > 4) {                       // scrolling down → hide, reset the up-buffer
    libChrome.upAccum = 0;
    setLibChrome(true);
  } else if (dy < 0) {                // scrolling up → only reveal after ~3.5 rows
    if (!libChrome.collapsed) return;
    libChrome.upAccum += -dy;
    const rowH = vgrid.rowH || 120;
    if (libChrome.upAccum > rowH * 3.5) { libChrome.upAccum = 0; setLibChrome(false); }
  }
}
// The peek handle is an explicit request — reveal immediately.
function expandLibChrome() {
  libChrome.upAccum = 0;
  setLibChrome(false);
}

// Re-layout on window resize
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (document.getElementById('screen-library').classList.contains('active')) {
      // Full repaint: clear and rebuild window at new column count
      const grid = document.getElementById('photoGrid');
      grid.innerHTML = '';
      vgrid.rendered.clear();
      computeGridLayout();
      paintWindow(true);
    }
  }, 150);
});

function makeTile(item, idx, immediate) {
  const tile = document.createElement('div');
  tile.className = 'photo-tile' + (item.fav ? ' faved' : '') + (state.selected.has(item.id) ? ' selected' : '');
  tile.dataset.idx = idx;
  tile.dataset.id = item.id;

  const skel = document.createElement('div');
  skel.className = 'tile-skeleton';
  tile.appendChild(skel);

  // Multi-select checkbox (only visible in select mode, via body.select-mode CSS)
  const check = document.createElement('div');
  check.className = 'tile-check';
  tile.appendChild(check);

  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  // Library passes immediate=true to prefetch eagerly; search defers to lazyLoad.
  if (immediate) img.src = thumbUrl(item.id);
  else img.dataset.src = thumbUrl(item.id);
  img.addEventListener('load', () => skel.remove());
  img.addEventListener('error', () => skel.remove());
  // Cached thumbnails can fire 'load' before this listener attaches, leaving a
  // skeleton shimmering forever. (Only the eager/immediate path has a src yet.)
  if (immediate && img.complete && img.naturalWidth) skel.remove();
  tile.appendChild(img);

  if (item.kind === 'video') {
    const badge = document.createElement('div');
    badge.className = 'tile-video-badge';
    badge.textContent = item.duration_s ? '▶ ' + fmtDuration(item.duration_s) : '▶';
    tile.appendChild(badge);
  } else if (item.live_video_id) {
    const badge = document.createElement('div');
    badge.className = 'tile-live-badge';
    badge.textContent = 'LIVE';
    tile.appendChild(badge);
    attachLivePreview(tile, item.live_video_id);
  }

  const overlay = document.createElement('div');
  overlay.className = 'tile-overlay';
  const dateEl = document.createElement('div');
  dateEl.className = 'tile-date';
  dateEl.textContent = fmtDate(item.taken_at);
  overlay.appendChild(dateEl);
  tile.appendChild(overlay);

  // Only render the ♥ button if the current role has photos.favorite;
  // the server also enforces this (POST /fav/:id → requirePerm), so hiding
  // here is purely so nothing that would 403 is offered.
  if (havePerm('photos.favorite')) {
    const favBtn = document.createElement('div');
    favBtn.className = 'tile-fav';
    favBtn.textContent = item.fav ? '♥' : '♡';
    favBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await fetch(`/api/aurora/fav/${item.id}`, { method: 'POST' }).then(r => r.json());
        item.fav = res.fav;
        tile.classList.toggle('faved', !!res.fav);
        favBtn.textContent = res.fav ? '♥' : '♡';
      } catch(_) {}
    });
    tile.appendChild(favBtn);
  }

  // Outside select mode: tap opens the lightbox. In select mode, selection is
  // driven by the pointer handlers below (tap = toggle one, drag = sweep).
  tile.addEventListener('click', () => { if (!state.selectMode) openLightbox(idx); });
  tile.addEventListener('pointerdown', (e) => {
    if (!state.selectMode || e.button === 2) return;
    if (e.target.closest('.tile-fav')) return;
    e.preventDefault();
    startDragSelect(idx, e);
  });

  // Long-press (touch) or right-click (desktop) → metadata panel from the grid
  // (disabled in select mode, where drag = sweep-select).
  let lpTimer = null;
  tile.addEventListener('touchstart', () => {
    if (state.selectMode) return;
    lpTimer = setTimeout(() => openMetaPanelForId(item.id), 500);
  }, { passive: true });
  tile.addEventListener('touchend', () => clearTimeout(lpTimer));
  tile.addEventListener('touchmove', () => clearTimeout(lpTimer), { passive: true });
  tile.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!state.selectMode) openMetaPanelForId(item.id); });

  return tile;
}

// Live Photo hover preview: on hover-capable devices, play the motion clip
// muted+looping inside the tile. A short delay avoids loading clips during a
// quick mouse sweep across the grid. Touch devices skip this entirely.
const _canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
function attachLivePreview(tile, liveVideoId) {
  if (!_canHover) return;
  let vid = null, timer = null;
  const stop = () => {
    clearTimeout(timer); timer = null;
    if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); vid.remove(); vid = null; }
  };
  tile.addEventListener('pointerenter', (e) => {
    window.__auroraPerf.lastPointerType = e.pointerType || '?';
    // ONLY a real mouse — never touch/pen. matchMedia('(hover:hover)') lies on
    // some tablets; without this gate, touch-scrolling a grid would spawn and
    // STREAM a video for every tile the finger passes over → the phone cooks.
    if (e.pointerType !== 'mouse') return;
    if (state.selectMode || vid) return;
    timer = setTimeout(() => {
      vid = document.createElement('video');
      vid.className = 'tile-live-preview';
      vid.muted = true; vid.loop = true; vid.playsInline = true; vid.preload = 'auto';
      vid.src = `/api/aurora/video/${liveVideoId}`;
      tile.appendChild(vid);
      window.__auroraPerf.previewsCreated++;
      vid.play().catch(() => {});
    }, 160);
  });
  tile.addEventListener('pointerleave', stop);
  tile.addEventListener('pointercancel', stop);
}

function openMetaPanelForId(id) {
  loadMetaPanel(id);
  document.getElementById('metaPanel').classList.add('open');
}

// ── Multi-select & bulk tagging ──────────────────────────────────────────────
function setSelectBtns(label) {
  ['libSelectBtn', 'searchSelectBtn'].forEach(id => { const b = document.getElementById(id); if (b) b.textContent = label; });
}
function toggleSelectMode() {
  if (state.selectMode) { exitSelectMode(); return; }
  state.selectMode = true;
  document.body.classList.add('select-mode');
  setSelectBtns('Cancel');
  updateSelCount();
}
function exitSelectMode() {
  state.selectMode = false;
  state.selected.clear();
  document.body.classList.remove('select-mode');
  cancelSelEntry();
  const menu = document.getElementById('selTagMenu'); if (menu) menu.style.display = 'none';
  refreshSelectionVisuals();
  setSelectBtns('Select');
}
function toggleSelect(id, tile) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  if (tile) tile.classList.toggle('selected', state.selected.has(id));
  updateSelCount();
}
function refreshSelectionVisuals() {
  document.querySelectorAll('.photo-tile').forEach(t => {
    t.classList.toggle('selected', state.selected.has(parseInt(t.dataset.id)));
  });
}

// ── Drag-select (iOS Photos style sweep) ──
let dragSel = null, autoScrollV = 0, autoScrollRAF = null;
function startDragSelect(startIdx, e) {
  const item = state.selectList[startIdx];
  if (!item) return;
  dragSel = {
    startIdx,
    base: new Set(state.selected),
    target: !state.selected.has(item.id),  // start tile's new state; the sweep applies the same
    lastIdx: startIdx,
    lastX: e.clientX, lastY: e.clientY,
  };
  applyDragRange(startIdx);
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', endDragSelect, { once: true });
  window.addEventListener('pointercancel', endDragSelect, { once: true });
}
function onDragMove(e) {
  if (!dragSel) return;
  e.preventDefault();
  dragSel.lastX = e.clientX; dragSel.lastY = e.clientY;
  dragHitTest();
  autoScrollEdges(e.clientY);
}
function dragHitTest() {
  if (!dragSel) return;
  const el = document.elementFromPoint(dragSel.lastX, dragSel.lastY);
  const tile = el && el.closest ? el.closest('.photo-tile') : null;
  if (tile && tile.dataset.idx !== undefined) {
    const idx = parseInt(tile.dataset.idx);
    if (idx !== dragSel.lastIdx) { dragSel.lastIdx = idx; applyDragRange(idx); }
  }
}
function applyDragRange(curIdx) {
  const lo = Math.min(dragSel.startIdx, curIdx), hi = Math.max(dragSel.startIdx, curIdx);
  const sel = new Set(dragSel.base);
  for (let i = lo; i <= hi; i++) {
    const it = state.selectList[i];
    if (!it) continue;
    if (dragSel.target) sel.add(it.id); else sel.delete(it.id);
  }
  state.selected = sel;
  refreshSelectionVisuals();
  updateSelCount();
}
function endDragSelect() {
  dragSel = null;
  window.removeEventListener('pointermove', onDragMove);
  stopAutoScroll();
}
// Auto-scroll the grid when dragging near its top/bottom edge, re-hit-testing
// each frame so the sweep keeps extending while the content moves under a still finger.
function autoScrollEdges(clientY) {
  const wrap = document.getElementById('photoGridWrap');
  const r = wrap.getBoundingClientRect();
  const EDGE = 72;
  if (clientY < r.top + EDGE) autoScrollV = -Math.ceil((r.top + EDGE - clientY) / 5);
  else if (clientY > r.bottom - EDGE) autoScrollV = Math.ceil((clientY - (r.bottom - EDGE)) / 5);
  else autoScrollV = 0;
  if (autoScrollV && !autoScrollRAF) autoScrollRAF = requestAnimationFrame(autoScrollStep);
}
function autoScrollStep() {
  autoScrollRAF = null;
  if (!dragSel || !autoScrollV) return;
  const wrap = document.getElementById('photoGridWrap');
  wrap.scrollTop += autoScrollV;        // fires the scroll listener → repaints tiles
  dragHitTest();                         // extend selection to whatever is now under the finger
  autoScrollRAF = requestAnimationFrame(autoScrollStep);
}
function stopAutoScroll() { autoScrollV = 0; if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; } }
function updateSelCount() {
  const n = state.selected.size;
  const el = document.getElementById('selCount');
  if (el) el.textContent = n.toLocaleString() + ' selected';
}
function selSelectAll() {
  for (const it of (state.selectList || [])) state.selected.add(it.id);
  refreshSelectionVisuals(); updateSelCount();
}
function selStartAddTag() {
  if (!state.selected.size) { toast('Select some photos first'); return; }
  document.getElementById('selTagMenu').style.display = 'none';
  const e = document.getElementById('selTagEntry');
  e.style.display = 'flex';
  const i = document.getElementById('selTagInput'); i.value = ''; i.focus();
}
function cancelSelEntry() { const e = document.getElementById('selTagEntry'); if (e) e.style.display = 'none'; }
async function selApplyAddTag() {
  const name = (document.getElementById('selTagInput').value || '').trim();
  const ids = [...state.selected];
  if (!name || !ids.length) return;
  const done = btnBusy(document.getElementById('selAddConfirmBtn'), 'Tagging…');
  try {
    const r = await fetch('/api/aurora/tags/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'add', name, assetIds: ids })
    }).then(r => r.json());
    done();
    cancelSelEntry();
    if (r.error) { toast('Failed: ' + r.error); return; }
    toast(`Added “${r.name}” to ${(r.added || 0).toLocaleString()} photo${r.added === 1 ? '' : 's'}`);
  } catch (_) { done(); toast('Failed to tag'); }
}
async function selStartRemoveTag() {
  if (!state.selected.size) { toast('Select some photos first'); return; }
  cancelSelEntry();
  const menu = document.getElementById('selTagMenu');
  menu.style.display = 'flex';
  menu.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Loading…</span>';
  try {
    const tags = await fetch('/api/aurora/tags/for-assets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: [...state.selected] })
    }).then(r => r.json());
    if (!tags.length) { menu.innerHTML = '<span style="font-size:12px;color:var(--text-faint)">No tags on the selected photos</span>'; return; }
    menu.innerHTML = '<span style="font-size:11px;color:var(--text-muted);width:100%;text-align:center;">Tap a tag to remove it from the selection</span>';
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = escapeHtml(t.name) + `<span class="chip-count">${t.count}</span>`;
      chip.addEventListener('click', () => selRemoveTag(t.id, t.name));
      menu.appendChild(chip);
    }
  } catch (_) { menu.innerHTML = '<span style="font-size:12px;color:#f87171">Failed to load tags</span>'; }
}
// Share the selected photos/videos. Prefers the native OS share sheet (Web Share
// API), which only exists in a SECURE context (HTTPS / localhost). Aurora is
// normally served over plain HTTP on a LAN IP, where the API is absent on every
// device — so we fall back transparently to a download (single file, or a zip).
const SHARE_MAX = 30; // native share fetches files into memory — keep it modest
const SHARE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heic', 'image/webp': 'webp', 'image/gif': 'gif', 'image/tiff': 'tif', 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/webm': 'webm' };
async function shareSelection() {
  const ids = [...state.selected];
  if (!ids.length) { toast('Select some photos first'); return; }

  if (navigator.share && navigator.canShare && ids.length <= SHARE_MAX) {
    const done = btnBusy(document.getElementById('selShareBtn'), 'Preparing…');
    try {
      const files = [];
      for (const id of ids) {
        const resp = await fetch(`/api/aurora/original/${id}`);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        files.push(new File([blob], `aurora-${id}.${SHARE_EXT[blob.type] || 'jpg'}`, { type: blob.type || 'application/octet-stream' }));
      }
      if (files.length && navigator.canShare({ files })) {
        done();
        await navigator.share({ files, title: files.length === 1 ? 'Aurora photo' : `${files.length} Aurora photos` });
        return; // shared, or the user dismissed the sheet — done either way
      }
      done(); // files not shareable here → fall through to download
    } catch (e) {
      done();
      if (e && e.name === 'AbortError') return; // user cancelled the share sheet
      // any other failure → fall through to the download fallback
    }
  }
  downloadSelection(ids);
}

// Transparent fallback when the native share sheet isn't available: one original
// downloads directly; a multi-selection downloads as a single zip (streamed).
function downloadSelection(ids) {
  const a = document.createElement('a');
  a.style.display = 'none';
  if (ids.length === 1) {
    a.href = `/api/aurora/original/${ids[0]}?dl=1`;
    a.download = '';
    toast('Downloading photo…');
  } else {
    const capped = ids.slice(0, 200);
    a.href = `/api/aurora/share/zip?ids=${capped.join(',')}`;
    a.download = 'aurora-photos.zip';
    toast(ids.length > 200 ? `Downloading first 200 of ${ids.length} as a zip…` : `Preparing ${capped.length} photos as a zip…`);
  }
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

async function selRemoveTag(tagId, name) {
  const ids = [...state.selected];
  try {
    const r = await fetch('/api/aurora/tags/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'remove', tagId, assetIds: ids })
    }).then(r => r.json());
    document.getElementById('selTagMenu').style.display = 'none';
    if (r.error) { toast('Failed: ' + r.error); return; }
    toast(`Removed “${name}” from ${(r.removed || 0).toLocaleString()} photo${r.removed === 1 ? '' : 's'}`);
  } catch (_) { toast('Failed to remove tag'); }
}

// Search grid is capped at 200 results, so it renders directly (no windowing)
let ioObserver = null;
function lazyLoad() {
  if (ioObserver) ioObserver.disconnect();
  ioObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        ioObserver.unobserve(img);
      }
    }
  }, { rootMargin: '200px' });
  document.querySelectorAll('img[data-src]').forEach(img => ioObserver.observe(img));
}

// ── Sliders ──
const timeFrom = document.getElementById('timeFrom');
const timeTo = document.getElementById('timeTo');
const dualFill = document.getElementById('dualFill');

// Position the fill bar between the two thumb centres. A range thumb at
// value v sits at v% of (track − thumb), not v% of the track, so compensate
// by the 18px thumb width or the fill drifts off the thumbs near the edges.
function updateDualRange() {
  const max = Math.max(1, state.totalMonths - 1);
  const a = (state.fromMonth / max) * 100, b = (state.toMonth / max) * 100;
  dualFill.style.left = `calc(${a} * (100% - 18px) / 100 + 9px)`;
  dualFill.style.width = `calc(${Math.max(0, b - a)} * (100% - 18px) / 100)`;
  // When both thumbs stack at the far right, the FROM thumb must sit on top
  // so it can still be grabbed and dragged left; mirrored at the far left,
  // where DOM order already puts the TO thumb on top.
  timeFrom.style.zIndex = state.fromMonth > max / 2 ? 4 : 2;
  timeTo.style.zIndex = 3;
}

// Year labels under the track (Januaries, thinned to at most ~8).
function buildRangeTicks() {
  const el = document.getElementById('rangeTicks');
  el.innerHTML = '';
  const maxIdx = state.totalMonths - 1;
  if (maxIdx < 1) return;
  const marks = [];
  for (let i = 0; i <= maxIdx; i++) {
    if (new Date(addMonths(state.monthBase, i)).getMonth() === 0) marks.push(i);
  }
  const step = Math.max(1, Math.ceil(marks.length / 8));
  for (let j = 0; j < marks.length; j += step) {
    const i = marks[j];
    const pct = (i / maxIdx) * 100;
    const tick = document.createElement('span');
    tick.className = 'range-tick';
    tick.textContent = String(new Date(addMonths(state.monthBase, i)).getFullYear());
    if (pct < 3) { tick.style.left = '0'; tick.style.transform = 'none'; }
    else if (pct > 97) { tick.style.left = '100%'; tick.style.transform = 'translateX(-100%)'; }
    else tick.style.left = pct + '%';
    el.appendChild(tick);
  }
}

function updateTimeLabel() {
  const lbl = document.getElementById('timeRangeLabel');
  const full = state.fromMonth <= 0 && state.toMonth >= state.totalMonths - 1;
  lbl.classList.toggle('narrowed', !full);
  updateDualRange();
  if (full) { lbl.textContent = 'All time'; lbl.title = ''; return; }
  lbl.title = 'Reset to all time';
  const from = addMonths(state.monthBase, state.fromMonth);
  const to = addMonths(state.monthBase, state.toMonth);
  lbl.textContent = state.fromMonth === state.toMonth ? fmtMonShort(from) : fmtMonShort(from) + ' – ' + fmtMonShort(to);
}

// Clicking the readout resets to the full range.
document.getElementById('timeRangeLabel').addEventListener('click', () => {
  if (state.fromMonth <= 0 && state.toMonth >= state.totalMonths - 1) return;
  state.fromMonth = 0; state.toMonth = state.totalMonths - 1;
  timeFrom.value = 0; timeTo.value = state.toMonth;
  updateTimeLabel(); applyFilters();
});

// Debounce the heavy applyFilters() (grid rebuild) while dragging.
// The label and histogram highlight update instantly to give live feedback.
let _filterTimer = null;
function scheduleFilters() {
  updateHistogramRange();
  clearTimeout(_filterTimer);
  _filterTimer = setTimeout(applyFilters, 140);
}

timeFrom.addEventListener('input', () => {
  state.fromMonth = Math.min(parseInt(timeFrom.value), state.toMonth);
  timeFrom.value = state.fromMonth;
  updateTimeLabel(); scheduleFilters();
});
timeTo.addEventListener('input', () => {
  state.toMonth = Math.max(parseInt(timeTo.value), state.fromMonth);
  timeTo.value = state.toMonth;
  updateTimeLabel(); scheduleFilters();
});

document.getElementById('densitySlider').addEventListener('input', function() {
  state.tileSize = parseInt(this.value);
  document.getElementById('densityVal').textContent = this.value + 'px';
  document.documentElement.style.setProperty('--tile-size', this.value + 'px');
  // Re-layout the virtualized grid at the new tile size
  const grid = document.getElementById('photoGrid');
  grid.innerHTML = '';
  vgrid.rendered.clear();
  computeGridLayout();
  paintWindow(true);
});

// ── Tab filters ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.kindFilter = btn.dataset.filter;
    applyFilters();
  });
});

// ── Lightbox ──
// Preload cache: keyed by asset id, value is the Image object (may still be loading).
const lbPreloadCache = new Map();
const LB_PRELOAD_LIMIT = 12; // max cached images

function lbPreload(item) {
  if (!item || item.kind === 'video' || lbPreloadCache.has(item.id)) return;
  if (lbPreloadCache.size >= LB_PRELOAD_LIMIT) {
    // evict the oldest entry
    lbPreloadCache.delete(lbPreloadCache.keys().next().value);
  }
  const pre = new Image();
  pre.src = thumbUrl(item.id, 'full');
  lbPreloadCache.set(item.id, pre);
}

function openLightbox(idx) {
  const item = state.lightboxItems[idx];
  if (!item) return;
  state.lightboxIdx = idx;
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightboxImg');
  const vid = document.getElementById('lightboxVideo');
  lb.classList.add('open');
  lb.classList.remove('chrome-hidden');

  // Nav arrows availability
  document.getElementById('lbPrev').style.visibility = idx > 0 ? 'visible' : 'hidden';
  document.getElementById('lbNext').style.visibility = idx < state.lightboxItems.length - 1 ? 'visible' : 'hidden';

  resetLightboxZoom();
  vid.classList.remove('live-overlay'); // clear any leftover Live Photo overlay
  lb.classList.toggle('is-video', item.kind === 'video');
  if (item.kind === 'video') {
    img.style.display = 'none'; img.src = '';
    vid.style.display = 'block';
    vid.setAttribute('controls', ''); vid.loop = false;
    clearVideoOrientation(vid);
    vid.onloadedmetadata = () => applyVideoOrientation(item);
    vid.src = `/api/aurora/video/${item.id}`;
    vid.play().catch(() => {});
  } else {
    clearVideoOrientation(vid); vid.onloadedmetadata = null;
    vid.style.display = 'none'; vid.pause(); vid.src = '';
    img.style.display = 'block';
    const cached = lbPreloadCache.get(item.id);
    if (cached && cached.complete && cached.naturalWidth) {
      // Already preloaded — show full image immediately, no thumb flash
      img.src = cached.src;
    } else {
      // Show the grid thumb instantly while the full image loads
      img.src = thumbUrl(item.id, 'grid');
      const full = cached || new Image();
      if (!cached) {
        full.src = thumbUrl(item.id, 'full');
        lbPreloadCache.set(item.id, full);
      }
      const swap = () => { if (state.lightboxIdx === idx) img.src = full.src; };
      full.onload = swap;
      // Guard the race where a preloaded image completed between the .complete
      // check above and now — onload won't fire for an already-loaded image,
      // which would otherwise leave the lightbox stuck on the grid thumb.
      if (full.complete && full.naturalWidth) swap();
    }
    // Preload neighbours so navigating is instant
    for (let d = 1; d <= 2; d++) {
      lbPreload(state.lightboxItems[idx - d]);
      lbPreload(state.lightboxItems[idx + d]);
    }
  }

  // Live Photo: offer the LIVE affordance on stills that have a motion clip
  const liveBtn = document.getElementById('lbLiveBtn');
  liveBtn.style.display = (item.kind === 'photo' && item.live_video_id) ? 'flex' : 'none';
  liveBtn.classList.remove('active');

  document.getElementById('lightboxTitle').textContent = fmtDate(item.taken_at);
  // Fav button state
  const favBtn = document.getElementById('lbFavBtn');
  favBtn.textContent = item.fav ? '♥' : '♡';
  favBtn.classList.toggle('active', !!item.fav);

  // Refresh the metadata panel if it's open
  if (document.getElementById('metaPanel').classList.contains('open')) loadMetaPanel(item.id);
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.classList.remove('open', 'fill', 'chrome-hidden', 'is-video');
  const vid = document.getElementById('lightboxVideo');
  vid.pause(); vid.src = ''; vid.onloadedmetadata = null; vid.classList.remove('live-overlay');
  clearVideoOrientation(vid);
  resetLightboxZoom();
  closeMetaPanel();
}

function lightboxNav(dir) {
  const next = state.lightboxIdx + dir;
  if (next < 0 || next >= state.lightboxItems.length) return;
  openLightbox(next);
}

function toggleLightboxFit() {
  const lb = document.getElementById('lightbox');
  lb.classList.toggle('fill');
  document.getElementById('lbFitBtn').classList.toggle('active', lb.classList.contains('fill'));
  // A CSS-rotated video is sized in JS, so re-fit it when the mode flips.
  const item = state.lightboxItems[state.lightboxIdx];
  if (item && item.kind === 'video') applyVideoOrientation(item);
}

// ── Video orientation correction ──
// iOS players honour a portrait video's rotation matrix automatically; some
// Android browsers decode the raw (landscape) frame instead, so a portrait
// clip shows sideways and stretched. We detect that case — metadata rotation
// is 90/270 but the browser rendered it landscape — and rotate it ourselves,
// swapping the box dimensions so the aspect stays correct. Browsers that
// already rotated (portrait render) are left untouched.
function clearVideoOrientation(vid) {
  vid.classList.remove('rotated');
  vid.style.transform = ''; vid.style.width = ''; vid.style.height = ''; vid.style.objectFit = '';
}
function applyVideoOrientation(item) {
  const vid = document.getElementById('lightboxVideo');
  clearVideoOrientation(vid);
  if (!item || item.kind !== 'video' || vid.classList.contains('live-overlay')) return;
  const rot = ((item.rotation || 0) % 360 + 360) % 360;
  if (rot !== 90 && rot !== 270) return;                 // only these produce the bug
  const vw = vid.videoWidth, vh = vid.videoHeight;
  if (!vw || !vh) return;                                // metadata not ready yet
  if (vh > vw) return;                                   // browser already rotated it — fine
  const stage = document.getElementById('lightboxStage').getBoundingClientRect();
  const fill = document.getElementById('lightbox').classList.contains('fill');
  vid.style.width = stage.height + 'px';
  vid.style.height = stage.width + 'px';
  vid.style.objectFit = fill ? 'cover' : 'contain';
  vid.style.transform = 'rotate(' + rot + 'deg)';
  vid.classList.add('rotated');
}
// Keep a rotated video correctly sized across viewport / orientation changes.
window.addEventListener('resize', () => {
  const vid = document.getElementById('lightboxVideo');
  if (vid && vid.classList.contains('rotated')) {
    applyVideoOrientation(state.lightboxItems[state.lightboxIdx]);
  }
});

// Play a Live Photo's motion clip over the still, once, then restore the still.
// The clip is shown as an absolutely-positioned overlay (.live-overlay) so it
// sits ON TOP of the photo rather than beside it.
function playLive() {
  const item = state.lightboxItems[state.lightboxIdx];
  if (!item || !item.live_video_id) return;
  const vid = document.getElementById('lightboxVideo');
  const liveBtn = document.getElementById('lbLiveBtn');
  liveBtn.classList.add('active');
  // The still stays visible underneath; the clip covers it exactly.
  vid.removeAttribute('controls'); vid.loop = false; vid.muted = false;
  vid.classList.add('live-overlay');
  vid.src = `/api/aurora/video/${item.live_video_id}`;
  vid.style.display = 'block';
  try { vid.currentTime = 0; } catch (_) {}
  vid.play().catch(() => {});
  const restore = () => {
    vid.removeEventListener('ended', restore);
    vid.pause(); vid.src = ''; vid.style.display = 'none';
    vid.classList.remove('live-overlay');
    vid.setAttribute('controls', '');
    liveBtn.classList.remove('active');
  };
  vid.addEventListener('ended', restore);
}

async function lightboxToggleFav() {
  const item = state.lightboxItems[state.lightboxIdx];
  if (!item) return;
  try {
    const res = await fetch(`/api/aurora/fav/${item.id}`, { method: 'POST' }).then(r => r.json());
    item.fav = res.fav;
    const favBtn = document.getElementById('lbFavBtn');
    favBtn.textContent = res.fav ? '♥' : '♡';
    favBtn.classList.toggle('active', !!res.fav);
    // Reflect in any rendered grid tile
    const tile = vgrid.rendered.get(state.lightboxIdx);
    if (tile) { tile.classList.toggle('faved', !!res.fav); const fb = tile.querySelector('.tile-fav'); if (fb) fb.textContent = res.fav ? '♥' : '♡'; }
  } catch(_) {}
}

// Tap on the image toggles the chrome (iOS Photos style). Delayed so a
// double-tap (zoom) doesn't also toggle chrome, and suppressed after a pan.
let lbChromeTimer = null;
document.getElementById('lightboxStage').addEventListener('click', (e) => {
  if (e.target.id !== 'lightboxImg') return;
  if (lbZoomMoved) { lbZoomMoved = false; return; }   // was a pan-drag
  if (lbChromeTimer) { clearTimeout(lbChromeTimer); lbChromeTimer = null; return; } // part of a dblclick
  lbChromeTimer = setTimeout(() => {
    lbChromeTimer = null;
    if (lbZoom.scale === 1) document.getElementById('lightbox').classList.toggle('chrome-hidden');
  }, 260);
});
// Click on empty backdrop closes
document.getElementById('lightbox').addEventListener('click', function(e) {
  if (e.target === this || e.target.id === 'lightboxStage') closeLightbox();
});

document.addEventListener('keydown', (e) => {
  if (!document.getElementById('lightbox').classList.contains('open')) return;
  // Never hijack keystrokes while the user is typing (e.g. adding a tag in the
  // info panel) — otherwise letters like "i"/"f" trigger lightbox shortcuts
  // and, in the tag field, "i" closed the panel mid-word. Escape still works
  // as a way out of the field; the rest are ignored when a field is focused.
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (typing) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowRight') lightboxNav(1);
  if (e.key === 'ArrowLeft') lightboxNav(-1);
  if (e.key === 'f' || e.key === 'F') toggleLightboxFit();
  if (e.key === 'i' || e.key === 'I') toggleMetaPanel();
});

// Video playback: fade our chrome out shortly after play (so the top bar
// never sits over the video's own transport controls) and bring it back on
// pause/end. The Live Photo overlay clip is exempt — it keeps the chrome.
(function() {
  const vid = document.getElementById('lightboxVideo');
  const lb = () => document.getElementById('lightbox');
  let hideT = null;
  vid.addEventListener('play', () => {
    if (vid.classList.contains('live-overlay')) return;
    clearTimeout(hideT);
    hideT = setTimeout(() => { if (!vid.paused) lb().classList.add('chrome-hidden'); }, 1500);
  });
  const reveal = () => { clearTimeout(hideT); lb().classList.remove('chrome-hidden'); };
  vid.addEventListener('pause', reveal);
  vid.addEventListener('ended', reveal);
})();

// ── Touch gestures: swipe left/right to navigate, swipe down to close ──
// Only active at 1× — when zoomed, one-finger drag pans the image instead.
(function() {
  const stage = document.getElementById('lightboxStage');
  let sx = 0, sy = 0, tracking = false;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || lbZoom.scale > 1) { tracking = false; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!tracking || lbZoom.scale > 1) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      lightboxNav(dx < 0 ? 1 : -1);
    } else if (dy > 90 && Math.abs(dx) < 60) {
      closeLightbox();
    }
  }, { passive: true });
})();

// ── Lightbox pan & zoom (wheel, double-tap, pinch, drag) ──
// Transform lives on #lightboxImg; we keep the focal point under the cursor
// stationary while scaling, and clamp panning to the scaled bounds.
const lbZoom = { scale: 1, tx: 0, ty: 0 };
let lbZoomMoved = false;

function applyLbZoom() {
  const img = document.getElementById('lightboxImg');
  img.style.transform = `translate(${lbZoom.tx}px, ${lbZoom.ty}px) scale(${lbZoom.scale})`;
  document.getElementById('lightbox').classList.toggle('zoomed', lbZoom.scale > 1);
}
function resetLightboxZoom() {
  lbZoom.scale = 1; lbZoom.tx = 0; lbZoom.ty = 0;
  const img = document.getElementById('lightboxImg');
  if (img) { img.style.transition = ''; img.style.transform = ''; }
  const lb = document.getElementById('lightbox');
  if (lb) lb.classList.remove('zoomed');
}
function clampLbPan() {
  const rect = document.getElementById('lightboxStage').getBoundingClientRect();
  const maxX = (lbZoom.scale - 1) * rect.width / 2;
  const maxY = (lbZoom.scale - 1) * rect.height / 2;
  lbZoom.tx = Math.max(-maxX, Math.min(maxX, lbZoom.tx));
  lbZoom.ty = Math.max(-maxY, Math.min(maxY, lbZoom.ty));
}
// Zoom to newScale keeping screen point (ox,oy) fixed.
function lbZoomTo(newScale, ox, oy) {
  newScale = Math.max(1, Math.min(6, newScale));
  const rect = document.getElementById('lightboxStage').getBoundingClientRect();
  const cx = ox - rect.left - rect.width / 2;   // focal point, relative to centre
  const cy = oy - rect.top - rect.height / 2;
  const ratio = newScale / lbZoom.scale;
  lbZoom.tx = cx - (cx - lbZoom.tx) * ratio;
  lbZoom.ty = cy - (cy - lbZoom.ty) * ratio;
  lbZoom.scale = newScale;
  if (lbZoom.scale === 1) { lbZoom.tx = 0; lbZoom.ty = 0; }
  clampLbPan();
  applyLbZoom();
}
const lbIsImage = () => {
  const it = state.lightboxItems[state.lightboxIdx];
  return it && it.kind !== 'video';
};

(function() {
  const stage = document.getElementById('lightboxStage');
  const img = document.getElementById('lightboxImg');

  stage.addEventListener('wheel', (e) => {
    if (!document.getElementById('lightbox').classList.contains('open') || !lbIsImage()) return;
    e.preventDefault();
    img.style.transition = 'transform 0.08s ease-out';
    lbZoomTo(lbZoom.scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18), e.clientX, e.clientY);
  }, { passive: false });

  stage.addEventListener('dblclick', (e) => {
    if (!lbIsImage()) return;
    e.preventDefault();
    img.style.transition = 'transform 0.18s ease-out';
    if (lbZoom.scale > 1) resetLightboxZoom();
    else lbZoomTo(2.5, e.clientX, e.clientY);
  });

  // Drag to pan when zoomed (pointer = mouse + single touch)
  let dragging = false, lastX = 0, lastY = 0;
  img.addEventListener('pointerdown', (e) => {
    if (lbZoom.scale <= 1) return;
    dragging = true; lbZoomMoved = false;
    lastX = e.clientX; lastY = e.clientY;
    try { img.setPointerCapture(e.pointerId); } catch (_) {}
    img.style.transition = 'none';
  });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) lbZoomMoved = true;
    lastX = e.clientX; lastY = e.clientY;
    lbZoom.tx += dx; lbZoom.ty += dy;
    clampLbPan(); applyLbZoom();
  });
  const endDrag = () => { dragging = false; };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);

  // Two-finger pinch
  let pinchDist = 0, pinchCX = 0, pinchCY = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && lbIsImage()) {
      pinchDist = dist(e.touches);
      pinchCX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinchCY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    }
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchDist > 0) {
      e.preventDefault();
      img.style.transition = 'none';
      const d = dist(e.touches);
      lbZoomTo(lbZoom.scale * (d / pinchDist), pinchCX, pinchCY);
      pinchDist = d;
    }
  }, { passive: false });
  stage.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinchDist = 0; });
})();

// ── Metadata panel ──
function toggleMetaPanel() {
  const p = document.getElementById('metaPanel');
  if (p.classList.contains('open')) { closeMetaPanel(); return; }
  const item = state.lightboxItems[state.lightboxIdx];
  if (item) loadMetaPanel(item.id);
  p.classList.add('open');
  document.getElementById('lbInfoBtn').classList.add('active');
}
function closeMetaPanel() {
  document.getElementById('metaPanel').classList.remove('open');
  const b = document.getElementById('lbInfoBtn'); if (b) b.classList.remove('active');
}

async function loadMetaPanel(id) {
  const body = document.getElementById('metaPanelBody');
  state.metaAssetId = id;
  body.innerHTML = '<div style="color:var(--text-faint);font-size:12px;">Loading…</div>';
  try {
    const a = await fetch(`/api/aurora/asset/${id}`).then(r => r.json());
    if (state.metaAssetId !== id) return; // panel moved on to another photo
    const rows = [];
    const row = (k, v, mono) => v != null && v !== '' ? `<div class="meta-row"><div class="meta-key">${k}</div><div class="meta-val ${mono?'mono':''}">${v}</div></div>` : '';
    const sect = (t) => `<div class="meta-section-title">${t}</div>`;

    rows.push(sect('File'));
    rows.push(row('Name', a.filename, true));
    rows.push(row('Type', (a.kind||'').toUpperCase() + (a.path ? ' · ' + a.path.split('.').pop().toUpperCase() : '')));
    rows.push(row('Size', fmtBytes(a.bytes), true));
    rows.push(row('Path', a.path, true));

    rows.push(sect('Capture'));
    rows.push(row('Date', a.taken_at ? new Date(a.taken_at).toLocaleString('en-GB') : 'Unknown', true));
    if (a.width) rows.push(row('Dimensions', `${a.width} × ${a.height}`, true));
    if (a.duration_s) rows.push(row('Duration', fmtDuration(a.duration_s), true));
    rows.push(row('Camera', a.camera));
    rows.push(row('Lens', a.lens));
    rows.push(row('Live Photo', a.live_video_id ? 'Yes — motion clip attached' : ''));

    if (a.gps_lat) {
      rows.push(sect('Location'));
      rows.push(row('Place', [a.place_name, a.place_country].filter(Boolean).join(', ')));
      rows.push(row('Coordinates', `${a.gps_lat.toFixed(5)}, ${a.gps_lon.toFixed(5)}`, true));
    }

    // Natural-language caption (read-only) — generated by the captioning worker
    if (a.caption) {
      rows.push(sect('Description'));
      rows.push(`<div class="meta-caption">${escapeHtml(a.caption)}</div>`);
    }

    // Tags section (interactive — populated after innerHTML is set)
    rows.push(sect('Tags'));
    rows.push('<div class="meta-tags" id="metaTags"></div>');
    rows.push('<div class="tag-add-row"><input id="metaTagInput" placeholder="Add a tag…" autocomplete="off" spellcheck="false" maxlength="80"><button id="metaTagAddBtn">Add</button></div>');
    rows.push('<div id="metaTagSuggest"></div>');

    // Privacy section
    const isHidden = !!(a.hidden);
    const privLabel = isHidden ? 'Remove from Hidden' : 'Hide photo';
    const privStyle = isHidden ? 'background:rgba(167,139,250,0.15);border-color:var(--accent);' : '';
    rows.push(sect('Privacy'));
    rows.push(`<div style="margin:4px 0 8px;"><button id="metaPrivBtn" style="font-size:12px;${privStyle}" class="btn btn-ghost">${isHidden ? '🔓 ' : '🔒 '}${privLabel}</button></div>`);

    // Remove-from-library section (soft delete; original file is never touched).
    if (havePerm('photos.delete')) {
      rows.push(sect('Manage'));
      rows.push('<div style="margin:4px 0 8px;"><button id="metaRemoveBtn" style="font-size:12px;color:#f87171;" class="btn btn-ghost">🗑 Remove from library</button></div>');
      rows.push('<div class="card-help" style="margin:0;">Hides it everywhere and stops it re-importing. The original file is kept and you can undo this from Settings → Manage removed.</div>');
    }

    body.innerHTML = rows.filter(Boolean).join('');

    document.getElementById('metaPrivBtn').addEventListener('click', () => {
      if (isHidden && !state.privateUnlocked) {
        showPasscodeModal('Enter passcode to unhide this photo', () => togglePrivatePhoto(id, isHidden));
      } else {
        togglePrivatePhoto(id, isHidden);
      }
    });
    const removeBtn = document.getElementById('metaRemoveBtn');
    if (removeBtn) removeBtn.addEventListener('click', () => removeAssetFromLibrary(id));

    renderMetaTags(a.tags || []);
    const input = document.getElementById('metaTagInput');
    document.getElementById('metaTagAddBtn').addEventListener('click', metaAddTag);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); metaAddTag(); } });
  } catch(_) {
    body.innerHTML = '<div style="color:#f87171;font-size:12px;">Failed to load metadata</div>';
  }
}

// ── Tags (info panel) ──
function renderMetaTags(tags) {
  const el = document.getElementById('metaTags');
  if (!el) return;
  if (!tags || !tags.length) { el.innerHTML = '<span class="meta-tags-empty">No tags yet — add one below.</span>'; return; }
  el.innerHTML = '';
  for (const t of tags) {
    const chip = document.createElement('span');
    chip.className = 'meta-tag';
    const label = document.createElement('span');
    label.textContent = t.name; label.title = 'Search this tag';
    label.addEventListener('click', () => searchTag(t.id, t.name));
    const x = document.createElement('button');
    x.className = 'tag-x'; x.textContent = '✕'; x.title = 'Remove tag';
    x.addEventListener('click', (e) => { e.stopPropagation(); metaRemoveTag(t.id); });
    chip.appendChild(label); chip.appendChild(x);
    el.appendChild(chip);
  }
}

async function metaAddTag() {
  const input = document.getElementById('metaTagInput');
  const name = (input.value || '').trim();
  const id = state.metaAssetId;
  if (!name || !id) return;
  const done = btnBusy(document.getElementById('metaTagAddBtn'), 'Adding…');
  try {
    const r = await fetch('/api/aurora/tags/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, assetIds: [id] })
    }).then(r => r.json());
    if (r.error) { toast('Tag failed: ' + r.error); done(); return; }
    input.value = '';
    done('Added ✓');
    const a = await fetch(`/api/aurora/asset/${id}`).then(r => r.json());
    if (state.metaAssetId === id) renderMetaTags(a.tags || []);
    checkSmartSuggestion(r.tagId, r.name);   // offer to tag the rest of the trip
  } catch (_) { toast('Tag failed'); done(); }
}

async function metaRemoveTag(tagId) {
  const id = state.metaAssetId;
  if (!id) return;
  try {
    await fetch('/api/aurora/tags/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId, assetIds: [id] })
    });
    const a = await fetch(`/api/aurora/asset/${id}`).then(r => r.json());
    if (state.metaAssetId === id) renderMetaTags(a.tags || []);
    dismissSuggestion();
  } catch (_) {}
}

// ── Smart tagging suggestion ──
async function checkSmartSuggestion(tagId, name) {
  const box = document.getElementById('metaTagSuggest');
  if (!box) return;
  box.innerHTML = '';
  try {
    const s = await fetch(`/api/aurora/tags/${tagId}/suggest` + (state.hideRaw ? '?hideRaw=1' : '')).then(r => r.json());
    if (!s.total || !s.window || !document.getElementById('metaTagSuggest')) return;
    const range = `${fmtDate(s.window.from)} – ${fmtDate(s.window.to)}`;
    const where = s.country ? ` in <b>${escapeHtml(s.country)}</b>` : '';
    box.innerHTML = `
      <div class="tag-suggest">
        💡 <b>${s.total.toLocaleString()}</b> more photo${s.total === 1 ? '' : 's'} from <b>${range}</b>${where} look like “${escapeHtml(name)}”.
        <div class="tag-suggest-actions">
          <button class="tag-suggest-add" id="suggestAddBtn">Tag all ${s.total.toLocaleString()}</button>
          <button class="tag-suggest-dismiss" onclick="dismissSuggestion()">Not now</button>
        </div>
      </div>`;
    document.getElementById('suggestAddBtn').addEventListener('click', () => applySmartSuggestion(tagId, name));
  } catch (_) {}
}

async function applySmartSuggestion(tagId, name) {
  const done = btnBusy(document.getElementById('suggestAddBtn'), 'Tagging…');
  try {
    const r = await fetch(`/api/aurora/tags/${tagId}/apply-suggestion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hideRaw: state.hideRaw })
    }).then(r => r.json());
    dismissSuggestion();
    toast(`Tagged ${(r.added || 0).toLocaleString()} more photos “${name}”`);
    if (state.metaAssetId) {
      const a = await fetch(`/api/aurora/asset/${state.metaAssetId}`).then(r => r.json());
      renderMetaTags(a.tags || []);
    }
  } catch (_) { toast('Failed to tag the trip'); done(); }
}

function dismissSuggestion() {
  const b = document.getElementById('metaTagSuggest');
  if (b) b.innerHTML = '';
}

// ── Places ──
const MAP_W = 1000, MAP_H = 500;
function projectLonLat(lon, lat) {
  return [(lon + 180) / 360 * MAP_W, (90 - lat) / 180 * MAP_H];
}

let worldMapRendered = false, worldLabels = [];
async function renderWorldMap() {
  if (worldMapRendered) return;
  try {
    // Cache-bust with PAGE_BUILD: /worldmap has a 24h public cache, so an
    // updated projection (e.g. the antimeridian fix in 1.6.5) would keep
    // serving stale JSON to any browser that hit the endpoint yesterday.
    // Rolling the query on every build makes each release fetch fresh.
    const wm = await fetch('/api/aurora/worldmap?v=' + encodeURIComponent(PAGE_BUILD)).then(r => r.json());
    const svg = document.getElementById('worldMap');
    let s = '';
    for (const d of wm.paths) s += '<path d="' + d + '"/>';
    svg.innerHTML = s;
    worldLabels = (wm.labels || []);   // [{name,x,y,r}] sorted largest-first
    worldMapRendered = true;
  } catch(_) {}
}

// Country-name labels: project each centroid, show only those big enough on
// screen at the current zoom, capped and de-cluttered (one per grid cell).
function renderCountryLabels() {
  const layer = document.getElementById('mapLabels');
  if (!layer || !mapView) return;
  const area = document.getElementById('mapArea');
  const w = area.clientWidth || 800, h = area.clientHeight || 500;
  const occupied = new Set();
  let shown = 0, html = '';
  for (const lb of worldLabels) {
    if (shown >= 14) break;
    const sx = (lb.x - mapView.x) / mapView.w * w;
    const sy = (lb.y - mapView.y) / mapView.h * h;
    if (sx < 0 || sy < 0 || sx > w || sy > h) continue;       // centroid off-screen
    if (lb.r / mapView.w * w < 55) continue;                  // country too small here
    const key = Math.floor(sx / 90) + ':' + Math.floor(sy / 90);
    if (occupied.has(key)) continue;                          // declutter
    occupied.add(key);
    html += `<div class="country-label" style="left:${(sx / w * 100).toFixed(2)}%;top:${(sy / h * 100).toFixed(2)}%">${escapeHtml(lb.name)}</div>`;
    shown++;
  }
  layer.innerHTML = html;
}

async function loadPlaces() {
  try {
    await renderWorldMap();
    // hideRaw MUST be passed so pin counts match what the preview + View-all
    // will actually return. Otherwise a RAW-only place reads "N photos" on the
    // pin but its preview grid comes back empty.
    const placesUrl = '/api/aurora/places' + (state.hideRaw ? '?hideRaw=1' : '');
    const places = await fetch(placesUrl).then(r => r.json());
    document.getElementById('placesCount').textContent = places.length + ' locations';
    document.getElementById('navBadgePlaces').textContent = places.length;

    const pins = document.getElementById('placePins');
    const placeholder = document.getElementById('mapPlaceholder');
    const svg = document.getElementById('worldMap');
    pins.innerHTML = '';

    const pts = [];
    for (const p of places) {
      if (p.lat == null || p.lon == null) continue;
      const [x, y] = projectLonLat(p.lon, p.lat);
      pts.push({ p, x, y });
    }
    if (!pts.length) { placeholder.style.display = 'flex'; svg.style.display = 'none'; return; }
    placeholder.style.display = 'none';
    svg.style.display = 'block';

    // Bounding box of the data (in projected 1000×500 space)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { x, y } of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    // Pad so pins aren't on the edge
    const padX = (maxX - minX) * 0.3 + 12, padY = (maxY - minY) * 0.3 + 12;
    let vbX = minX - padX, vbY = minY - padY;
    let vbW = (maxX - minX) + 2 * padX, vbH = (maxY - minY) + 2 * padY;

    // Match the container's aspect ratio so countries aren't distorted
    const area = document.getElementById('mapArea');
    const arc = (area.clientWidth || 800) / (area.clientHeight || 500);
    const arv = vbW / vbH;
    if (arc > arv) { const nw = vbH * arc; vbX -= (nw - vbW) / 2; vbW = nw; }
    else { const nh = vbW / arc; vbY -= (nh - vbH) / 2; vbH = nh; }

    svg.setAttribute('preserveAspectRatio', 'none');

    // Initial (home) view = the fitted bounding box; pan/zoom adjust this
    mapView = { x: vbX, y: vbY, w: vbW, h: vbH };
    mapHome = { ...mapView };
    mapAR = vbW / vbH;
    // Source places (projected into 1000×500 space). The pins themselves are
    // (re)built by renderMapPins(), which clusters places that fall close
    // together at the current zoom so they don't overlap into an unreadable blob.
    mapPlaces = pts;

    setupPlacesRange();   // wire the timeline slider to the loaded date domain
    applyMapView();
    setupMapInteractions();
  } catch(_) {}
}

// ── Places timeline filter ──
// Shares the library's month domain (state.monthBase / totalMonths). Dragging
// narrows which pins show: instantly by an overlap test on each place's date
// span, then corrected to accurate in-range counts by a debounced /places
// fetch. The map view (pan/zoom) is preserved across changes.
const pTimeFrom = document.getElementById('pTimeFrom');
const pTimeTo = document.getElementById('pTimeTo');
const pDualFill = document.getElementById('pDualFill');
let placesRangeReady = false;
function setupPlacesRange() {
  const controls = document.getElementById('placesControls');
  // No usable date span → hide the control and show everything.
  if (!state.totalMonths || state.totalMonths <= 1) {
    controls.style.display = 'none';
    placesRange = null; placesRangeCounts = null;
    return;
  }
  controls.style.display = '';
  const max = state.totalMonths - 1;
  // First time in (or the domain grew): default to the full span.
  if (!placesRangeReady || state.placesTo > max) { state.placesFrom = 0; state.placesTo = max; }
  pTimeFrom.min = pTimeTo.min = 0;
  pTimeFrom.max = pTimeTo.max = max;
  pTimeFrom.value = state.placesFrom;
  pTimeTo.value = state.placesTo;
  placesRangeReady = true;
  buildPlacesTicks();
  updatePlacesLabel();
  applyPlacesRange();
}
function buildPlacesTicks() {
  const el = document.getElementById('pRangeTicks');
  if (!el) return;
  el.innerHTML = '';
  const maxIdx = state.totalMonths - 1;
  if (maxIdx < 1) return;
  const marks = [];
  for (let i = 0; i <= maxIdx; i++) if (new Date(addMonths(state.monthBase, i)).getMonth() === 0) marks.push(i);
  const step = Math.max(1, Math.ceil(marks.length / 8));
  for (let j = 0; j < marks.length; j += step) {
    const i = marks[j], pct = (i / maxIdx) * 100;
    const tick = document.createElement('span');
    tick.className = 'range-tick';
    tick.textContent = String(new Date(addMonths(state.monthBase, i)).getFullYear());
    if (pct < 3) { tick.style.left = '0'; tick.style.transform = 'none'; }
    else if (pct > 97) { tick.style.left = '100%'; tick.style.transform = 'translateX(-100%)'; }
    else tick.style.left = pct + '%';
    el.appendChild(tick);
  }
}
function updatePlacesDualFill() {
  const max = Math.max(1, state.totalMonths - 1);
  const a = (state.placesFrom / max) * 100, b = (state.placesTo / max) * 100;
  pDualFill.style.left = `calc(${a} * (100% - 18px) / 100 + 9px)`;
  pDualFill.style.width = `calc(${Math.max(0, b - a)} * (100% - 18px) / 100)`;
  pTimeFrom.style.zIndex = state.placesFrom > max / 2 ? 4 : 2;
  pTimeTo.style.zIndex = 3;
}
function updatePlacesLabel() {
  const lbl = document.getElementById('pTimeRangeLabel');
  const full = state.placesFrom <= 0 && state.placesTo >= state.totalMonths - 1;
  lbl.classList.toggle('narrowed', !full);
  updatePlacesDualFill();
  if (full) { lbl.textContent = 'All time'; lbl.title = ''; return; }
  lbl.title = 'Reset to all time';
  const from = addMonths(state.monthBase, state.placesFrom);
  const to = addMonths(state.monthBase, state.placesTo);
  lbl.textContent = state.placesFrom === state.placesTo ? fmtMonShort(from) : fmtMonShort(from) + ' – ' + fmtMonShort(to);
}
// Recompute placesRange from the slider, refresh pins instantly, and schedule
// an accurate-count fetch.
function applyPlacesRange() {
  const max = state.totalMonths - 1;
  const full = state.placesFrom <= 0 && state.placesTo >= max;
  if (full) {
    placesRange = null; placesRangeCounts = null;
    clearTimeout(placesFetchTimer); placesFetchSeq++;
    renderMapPins();
    return;
  }
  const fromMs = addMonths(state.monthBase, state.placesFrom);
  const toMs = addMonths(state.monthBase, state.placesTo + 1) - 1;
  placesRange = { fromMs, toMs };
  placesRangeCounts = null;    // fall back to instant overlap until the fetch lands
  renderMapPins();
  const seq = ++placesFetchSeq;
  clearTimeout(placesFetchTimer);
  placesFetchTimer = setTimeout(async () => {
    try {
      const qs = `?from=${fromMs}&to=${toMs}` + (state.hideRaw ? '&hideRaw=1' : '');
      const rows = await fetch('/api/aurora/places' + qs).then(r => r.json());
      if (seq !== placesFetchSeq) return;   // superseded by a newer drag
      const m = new Map();
      for (const p of rows) m.set(p.id, p.count);
      placesRangeCounts = m;
      renderMapPins();
    } catch (_) {}
  }, 180);
}
if (pTimeFrom) {
  pTimeFrom.addEventListener('input', () => {
    state.placesFrom = Math.min(parseInt(pTimeFrom.value), state.placesTo);
    pTimeFrom.value = state.placesFrom;
    updatePlacesLabel(); applyPlacesRange();
  });
  pTimeTo.addEventListener('input', () => {
    state.placesTo = Math.max(parseInt(pTimeTo.value), state.placesFrom);
    pTimeTo.value = state.placesTo;
    updatePlacesLabel(); applyPlacesRange();
  });
  document.getElementById('pTimeRangeLabel').addEventListener('click', () => {
    const max = state.totalMonths - 1;
    if (state.placesFrom <= 0 && state.placesTo >= max) return;
    state.placesFrom = 0; state.placesTo = max;
    pTimeFrom.value = 0; pTimeTo.value = max;
    updatePlacesLabel(); applyPlacesRange();
  });
}

// ── Pan / zoom for the Places map ──
let mapView = null, mapHome = null, mapAR = 1, mapPlaces = [];
let mapDragMoved = false, mapInteractionsReady = false, pinsRaf = false;
// Timeline filter state (see renderMapPins): placesRange is the active window
// in ms (null = all time); placesRangeCounts is the authoritative id→in-range
// count from the server, or null while a fetch is pending / at full range.
let placesRange = null, placesRangeCounts = null, placesFetchSeq = 0, placesFetchTimer = null;

function applyMapView() {
  if (!mapView) return;
  const svg = document.getElementById('worldMap');
  svg.setAttribute('viewBox', `${mapView.x} ${mapView.y} ${mapView.w} ${mapView.h}`);
  // Re-cluster pins for the new view, coalesced to one rebuild per frame so a
  // pan-drag stays smooth.
  if (!pinsRaf) {
    pinsRaf = true;
    requestAnimationFrame(() => { pinsRaf = false; renderMapPins(); renderCountryLabels(); });
  }
}

// Cluster nearby places (in screen px) into single pins so they don't overlap.
// Cheap grid bucketing — re-run on every zoom/pan.
const PIN_CELL = 58; // px; larger = wider grouping
function renderMapPins() {
  if (!mapView) return;
  const area = document.getElementById('mapArea');
  const pins = document.getElementById('placePins');
  const w = area.clientWidth || 800, h = area.clientHeight || 500;

  const cells = new Map();
  for (const mp of mapPlaces) {
    // ── Timeline filter ──
    // placesRangeCounts (authoritative, from /places?from&to) decides both
    // visibility and the count once it has loaded; before it does we fall back
    // to an instant overlap test on the place's date span so pins drop off the
    // moment the range narrows, with no wait for the server.
    let cnt = mp.p.count;
    if (placesRangeCounts) {
      if (!placesRangeCounts.has(mp.p.id)) continue;   // no photos here in range
      cnt = placesRangeCounts.get(mp.p.id);
    } else if (placesRange) {
      if (!(mp.p.first_date <= placesRange.toMs && mp.p.last_date >= placesRange.fromMs)) continue;
    }
    if (!cnt) continue;
    const sx = (mp.x - mapView.x) / mapView.w * w;
    const sy = (mp.y - mapView.y) / mapView.h * h;
    if (sx < -PIN_CELL || sy < -PIN_CELL || sx > w + PIN_CELL || sy > h + PIN_CELL) continue; // off-screen
    const key = Math.floor(sx / PIN_CELL) + ':' + Math.floor(sy / PIN_CELL);
    let c = cells.get(key);
    if (!c) { c = { places: [], count: 0, sx: 0, sy: 0 }; cells.set(key, c); }
    c.places.push(mp.p); c.count += cnt; c.sx += sx; c.sy += sy;
  }

  let maxCount = 1;
  for (const c of cells.values()) if (c.count > maxCount) maxCount = c.count;

  // Once we're zoomed in to just a handful of pins, label them permanently.
  pins.classList.toggle('labels-on', cells.size > 0 && cells.size <= 12);

  pins.innerHTML = '';
  // Show permanent place names for single (non-cluster) pins, de-cluttered by
  // a coarse grid so labels never pile on top of each other. Hover still
  // reveals any pin's name (incl. clusters).
  const labelCells = new Set();
  let labelsShown = 0;
  for (const c of cells.values()) {
    const cx = c.sx / c.places.length, cy = c.sy / c.places.length;
    const single = c.places.length === 1;
    const pin = document.createElement('div');
    pin.className = 'place-pin' + (single ? '' : ' cluster');
    if (single && labelsShown < 18) {
      const lk = Math.floor(cx / 115) + ':' + Math.floor(cy / 42);
      if (!labelCells.has(lk)) { labelCells.add(lk); pin.classList.add('show-label'); labelsShown++; }
    }

    const size = 20 + Math.round((c.count / maxCount) * 26);
    const dot = document.createElement('div');
    dot.className = 'pin-dot';
    dot.style.width = dot.style.height = size + 'px';
    dot.style.fontSize = (size * 0.34) + 'px';
    dot.textContent = c.count >= 1000 ? Math.round(c.count / 1000) + 'k' : c.count;
    pin.appendChild(dot);

    const label = document.createElement('div');
    label.className = 'pin-label';
    label.textContent = single
      ? ([c.places[0].name, c.places[0].country].filter(Boolean).join(', ') || 'Unknown')
      : `${c.places.length} places · ${c.count.toLocaleString()} photos`;
    pin.appendChild(label);

    pin.style.left = (cx / w * 100) + '%';
    pin.style.top = (cy / h * 100) + '%';
    // Pin selection is bound to a per-pin pointerdown → pointerup pair with a
    // small movement budget. This is DELIBERATE — it decouples pin clicks from
    // the map's own drag/pan state so a stale mapDragMoved (e.g. left `true`
    // after a pan then a tap) can never swallow the click. On touch, the tiny
    // finger jitter that a bare `click` listener converts into a miss is
    // ignored as long as the pointer stays within TAP_SLOP of the pin.
    const TAP_SLOP = 8; // px
    let dx = 0, dy = 0, downX = 0, downY = 0, downOK = false;
    pin.addEventListener('pointerdown', (e) => {
      downOK = true; downX = e.clientX; downY = e.clientY; dx = dy = 0;
      e.stopPropagation();                       // don't let the map area steal it
    });
    pin.addEventListener('pointermove', (e) => {
      if (!downOK) return;
      dx = e.clientX - downX; dy = e.clientY - downY;
      if (Math.hypot(dx, dy) > TAP_SLOP) downOK = false;
    });
    pin.addEventListener('pointerup', (e) => {
      if (!downOK) return;
      downOK = false;
      e.stopPropagation();
      showPlaceGallery(c.places, pin);
    });
    pin.addEventListener('pointercancel', () => { downOK = false; });
    pins.appendChild(pin);
  }
}

// factor < 1 zooms in, > 1 zooms out, centred on (cx, cy) as 0..1 of the area
function zoomMap(factor, cx, cy) {
  if (!mapView) return;
  const wx = mapView.x + cx * mapView.w;
  const wy = mapView.y + cy * mapView.h;
  let nw = mapView.w * factor;
  nw = Math.max(3, Math.min(1100, nw));   // clamp zoom range
  const nh = nw / mapAR;
  mapView.x = wx - cx * nw;
  mapView.y = wy - cy * nh;
  mapView.w = nw; mapView.h = nh;
  applyMapView();
}

function resetMapView() {
  if (!mapHome) return;
  mapView = { ...mapHome };
  applyMapView();
}

function setupMapInteractions() {
  if (mapInteractionsReady) return;
  mapInteractionsReady = true;
  const area = document.getElementById('mapArea');

  // Wheel zoom toward cursor
  area.addEventListener('wheel', (e) => {
    if (!mapView) return;
    e.preventDefault();
    const r = area.getBoundingClientRect();
    const cx = (e.clientX - r.left) / r.width;
    const cy = (e.clientY - r.top) / r.height;
    zoomMap(e.deltaY < 0 ? 0.85 : 1 / 0.85, cx, cy);
  }, { passive: false });

  // Drag to pan (pointer events cover mouse + single-touch)
  let dragging = false, lastX = 0, lastY = 0, pinching = false;
  area.addEventListener('pointerdown', (e) => {
    if (pinching) return;
    // Every fresh press resets the pan-vs-click sentinel — even if it lands on
    // a pin. Historically it was only reset on the map's own drag branch, so a
    // prior pan left mapDragMoved=true and the very next pin tap saw the pin's
    // click handler abort silently. Kept globally reset here so pin selection
    // (which now uses its own pointerup gate) is never affected by legacy
    // callers that still consult mapDragMoved.
    mapDragMoved = false;
    // Press starting on a pin must NOT start a pan — otherwise pointer capture
    // swallows the pin's click and the gallery never opens.
    if (e.target.closest('.place-pin')) return;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    try { area.setPointerCapture(e.pointerId); } catch (_) {}
    area.classList.add('grabbing');
  });
  area.addEventListener('pointermove', (e) => {
    if (!dragging || !mapView || pinching) return;
    const r = area.getBoundingClientRect();
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) mapDragMoved = true;
    lastX = e.clientX; lastY = e.clientY;
    mapView.x -= dx / r.width * mapView.w;
    mapView.y -= dy / r.height * mapView.h;
    applyMapView();
  });
  const endDrag = () => { dragging = false; area.classList.remove('grabbing'); };
  area.addEventListener('pointerup', endDrag);
  area.addEventListener('pointercancel', endDrag);

  // Two-finger pinch zoom
  let pinchDist = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  area.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { pinching = true; dragging = false; pinchDist = dist(e.touches); }
  }, { passive: false });
  area.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && mapView) {
      e.preventDefault();
      const r = area.getBoundingClientRect();
      const d = dist(e.touches);
      const mx = ((e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left) / r.width;
      const my = ((e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top) / r.height;
      if (pinchDist > 0) zoomMap(pinchDist / d, mx, my);
      pinchDist = d;
    }
  }, { passive: false });
  area.addEventListener('touchend', (e) => { if (e.touches.length < 2) { pinching = false; pinchDist = 0; } });

  // Double-click to zoom in
  area.addEventListener('dblclick', (e) => {
    const r = area.getBoundingClientRect();
    zoomMap(0.6, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
}

function mapZoomBtn(dir) {
  // dir > 0 = zoom in (smaller view, factor < 1); dir < 0 = zoom out
  zoomMap(dir > 0 ? 0.7 : 1 / 0.7, 0.5, 0.5);
}

// Opens the place-detail panel for one place OR a whole cluster of places. Shows
// a small preview strip plus a "View all" button that hands off to the Search
// results page (filtered to this place), where the full set browses smoothly.
//
// Concurrency: rapid pin taps used to race — the slower fetch could clobber the
// panel that a newer click had already updated. `placeFetchCtrl` aborts the prior
// fetch on every new call, and `placeFetchSeq` guards the render so a late
// response for a superseded selection cannot overwrite the current one.
let placeFetchCtrl = null;
let placeFetchSeq = 0;
async function showPlaceGallery(places, pinEl) {
  if (!places || !places.length) return;
  const detail = document.getElementById('placeDetail');
  detail.style.display = 'flex';

  const single = places.length === 1;
  const firsts = places.map(p => p.first_date).filter(Boolean);
  const lasts = places.map(p => p.last_date).filter(Boolean);
  // When the timeline filter is active, the preview must honour it — same
  // window the pins were filtered by — otherwise "back to 2020" still opened
  // 2024 photos. Clamp the displayed date span to the window too.
  const range = placesRange ? { from: placesRange.fromMs, to: placesRange.toMs } : null;
  let firstDate = firsts.length ? Math.min(...firsts) : null;
  let lastDate = lasts.length ? Math.max(...lasts) : null;
  if (range) {
    if (firstDate != null) firstDate = Math.max(firstDate, range.from);
    if (lastDate != null) lastDate = Math.min(lastDate, range.to);
  }
  const ids = places.map(p => p.id).join(',');
  const name = single
    ? ([places[0].name, places[0].country].filter(Boolean).join(', ') || 'Unknown location')
    : `${places.length} places nearby`;

  document.getElementById('placeDetailName').textContent = name;
  state.placeSelection = { ids, name, range };

  // Mark active pin
  document.querySelectorAll('.place-pin').forEach(p => p.classList.remove('active'));
  if (pinEl) pinEl.classList.add('active');

  const grid = document.getElementById('placeDetailGrid');
  const meta = document.getElementById('placeDetailMeta');
  const btn = document.getElementById('placeViewAllBtn');
  meta.textContent = 'Loading…';
  btn.disabled = true; btn.textContent = 'View all photos →';
  grid.innerHTML = '<span style="font-size:11px;color:var(--text-faint)">Loading…</span>';

  // Cancel the previous request so it can't clobber this one on the render side.
  if (placeFetchCtrl) { try { placeFetchCtrl.abort(); } catch (_) {} }
  placeFetchCtrl = new AbortController();
  const mySeq = ++placeFetchSeq;

  try {
    const rangeQs = range ? `&from=${range.from}&to=${range.to}` : '';
    const res = await fetch(
      `/api/aurora/assets?place=${ids}&limit=12&count=1${rangeQs}${state.hideRaw ? '&hideRaw=1' : ''}`,
      { signal: placeFetchCtrl.signal }
    ).then(r => r.json());
    // Late response for a superseded click — drop it silently.
    if (mySeq !== placeFetchSeq) return;
    const total = res.total != null ? res.total : res.assets.length;
    state.placeSelection.total = total;
    meta.textContent = `${total.toLocaleString()} ${total === 1 ? 'photo' : 'photos'}  ·  ${fmtDate(firstDate)} – ${fmtDate(lastDate)}`;
    btn.disabled = total === 0;
    btn.textContent = total ? `View all ${total.toLocaleString()} photos →` : 'No viewable photos';

    // The preview thumbs are a small gallery for the lightbox.
    state.lightboxItems = res.assets;
    grid.innerHTML = '';
    if (!res.assets.length) {
      grid.innerHTML = '<span style="font-size:11px;color:var(--text-faint)">No viewable photos here</span>';
      return;
    }
    res.assets.forEach((a, idx) => {
      const tile = document.createElement('div');
      tile.className = 'place-mini-tile';
      const img = document.createElement('img');
      img.src = thumbUrl(a.id);
      tile.appendChild(img);
      if (a.kind === 'video') {
        const b = document.createElement('div'); b.className = 'tile-video-badge'; b.textContent = '▶'; tile.appendChild(b);
      } else if (a.live_video_id) {
        const b = document.createElement('div'); b.className = 'tile-live-badge'; b.textContent = 'LIVE'; tile.appendChild(b);
      }
      tile.addEventListener('click', () => openLightbox(idx));
      grid.appendChild(tile);
    });
  } catch (err) {
    // AbortError = superseded by a later click; leave the panel alone.
    if (err && err.name === 'AbortError') return;
    if (mySeq !== placeFetchSeq) return;
    grid.innerHTML = '<span style="font-size:11px;color:var(--text-faint)">Couldn’t load photos</span>';
    meta.textContent = '—';
  }
}

// "View all" → hand off to the Search results page, filtered to this place
// (and to the map's timeline window when one is active).
function placeViewAll() {
  if (!state.placeSelection || !state.placeSelection.ids) return;
  searchPlace(state.placeSelection.ids, state.placeSelection.name, state.placeSelection.range);
}

// ── Search ── the unified results page (also used by Places "View all")
const SEARCH_LIMIT = 500;
let searchTimer = null, searchSeq = 0;
// dateFrom/dateTo (ms, 0 = inactive) ride along with the place filter — they
// are only ever set by the Places map hand-off and cleared with it.
const searchState = { kind: '', camera: '', country: '', fav: false, placeIds: '', placeName: '', tag: '', tagName: '', terms: [], dateFrom: 0, dateTo: 0 };

// ── Search term chips ──
// Each Enter commits the current word as a removable chip; all chips are ANDed
// (strict intersection), e.g. "dog" + "cat" → only photos containing both.
function renderSearchChips() {
  const el = document.getElementById('searchChips');
  if (!el) return;
  el.innerHTML = '';
  for (const term of searchState.terms) {
    const chip = document.createElement('span');
    chip.className = 'search-term-chip';
    const label = document.createElement('span');
    label.textContent = term;
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '✕'; x.title = 'Remove';
    x.addEventListener('click', () => removeSearchTerm(term));
    chip.appendChild(label); chip.appendChild(x);
    el.appendChild(chip);
  }
}
function commitSearchTerm() {
  const input = document.getElementById('searchInput');
  const val = input.value.trim();
  if (!val) return;
  const lc = val.toLowerCase();
  if (!searchState.terms.some(t => t.toLowerCase() === lc)) searchState.terms.push(val);
  input.value = '';
  renderSearchChips();
  runSearch();
}
function removeSearchTerm(term) {
  searchState.terms = searchState.terms.filter(t => t !== term);
  renderSearchChips();
  runSearch();
}
function clearSearchTerms() { searchState.terms = []; renderSearchChips(); }

document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});
document.getElementById('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); commitSearchTerm(); }
  // Backspace on an empty box pops the last committed chip
  else if (e.key === 'Backspace' && !e.target.value && searchState.terms.length) {
    e.preventDefault(); searchState.terms.pop(); renderSearchChips(); runSearch();
  }
});

// Kind chips behave like radio buttons ("All" = no kind filter).
document.querySelectorAll('[data-search-filter="kind"]').forEach(chip => {
  chip.addEventListener('click', () => {
    searchState.kind = chip.dataset.val;
    document.querySelectorAll('[data-search-filter="kind"]').forEach(c => c.classList.toggle('active', c === chip));
    runSearch();
  });
});

function toggleFavFilter(el) {
  searchState.fav = !searchState.fav;
  el.classList.toggle('active', searchState.fav);
  runSearch();
}

// Single-select toggle for the camera / country chip groups.
function toggleSearchFilter(el, type, val) {
  if (searchState[type] === val) { searchState[type] = ''; el.classList.remove('active'); }
  else {
    document.querySelectorAll(`[data-search-filter="${type}"]`).forEach(c => c.classList.remove('active'));
    searchState[type] = val; el.classList.add('active');
  }
  runSearch();
}

function clearSearchPlace() {
  searchState.placeIds = ''; searchState.placeName = '';
  searchState.dateFrom = 0; searchState.dateTo = 0;
  runSearch();
}

// Entry point from the Places screen: open Search filtered to a place/cluster.
// `range` ({from,to} ms) is the map's timeline window, when one is active.
function searchPlace(ids, name, range) {
  searchState.placeIds = String(ids); searchState.placeName = name || 'Selected place';
  searchState.dateFrom = range && range.from ? range.from : 0;
  searchState.dateTo = range && range.to ? range.to : 0;
  searchState.kind = ''; searchState.camera = ''; searchState.country = ''; searchState.fav = false; searchState.tag = ''; searchState.tagName = '';
  const input = document.getElementById('searchInput'); if (input) input.value = ''; clearSearchTerms();
  switchScreen('search');
}

// Entry point from a tag chip (info panel): open Search filtered to one tag.
function searchTag(tagId, name) {
  searchState.tag = String(tagId); searchState.tagName = name || '';
  searchState.kind = ''; searchState.camera = ''; searchState.country = ''; searchState.fav = false; searchState.placeIds = ''; searchState.placeName = '';
  searchState.dateFrom = 0; searchState.dateTo = 0;
  const input = document.getElementById('searchInput'); if (input) input.value = ''; clearSearchTerms();
  closeMetaPanel();
  switchScreen('search');
}

async function loadSearch() {
  // Reflect current state on the kind/fav chips (they're pre-rendered in the
  // template — value-independent — so no fetch needed).
  document.querySelectorAll('[data-search-filter="kind"]').forEach(c => c.classList.toggle('active', c.dataset.val === searchState.kind));
  const fc = document.getElementById('favChip'); if (fc) fc.classList.toggle('active', searchState.fav);
  // The camera/country/tag chip lists are populated by runSearch()
  // itself now — the /assets response carries a `facets` block that reflects
  // the CURRENT result set. That means:
  //  • the counts stay honest as filters narrow (no more "iPhone X · 16,000"
  //    on a 30-result view — the classic reported bug), and
  //  • we save three extra HTTP roundtrips on screen entry.
  runSearch();
}

// ── Facet chip rendering (called from runSearch on every response) ─────
// Rebuild the chip DOM so counts always match the current result set. Order
// matters (highest count first, from the server). If the currently-active
// value isn't in the top-N slice, we prepend a synthetic entry pinned to
// the search total — otherwise the user's own selection would vanish.
function renderFacetChips(containerId, sectionId, list, keyField, activeVal, activeName, onClick) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const sec = sectionId ? document.getElementById(sectionId) : null;
  const items = list ? [...list] : [];
  if (activeVal !== '' && activeVal != null && !items.some(f => String(f[keyField]) === String(activeVal))) {
    // For tag chips the active chip needs a display name (server sent only
    // top-N so this one might not be in the response). We fall back to the
    // searchState.tagName captured when the chip was clicked.
    const synth = { [keyField]: activeVal, count: 0 };
    if (activeName) synth.name = activeName;
    items.unshift(synth);
  }
  // Section with dynamic visibility (tags): hide when the list is empty
  // AND nothing is active — otherwise the user just narrowed away all
  // matches but is still in "tag:X" mode, keep the section open.
  if (sec) sec.style.display = (items.length || activeVal) ? '' : 'none';
  if (!items.length) { el.innerHTML = '<span style="font-size:11px;color:var(--text-faint)">None</span>'; return; }
  el.innerHTML = '';
  for (const c of items) {
    const val = c[keyField];
    const label = c.name != null ? c.name : val;
    const chip = document.createElement('span');
    chip.className = 'chip' + (String(activeVal) === String(val) ? ' active' : '');
    chip.dataset.val = val;
    chip.innerHTML = escapeHtml(String(label)) + `<span class="chip-count">${(c.count || 0).toLocaleString()}</span>`;
    chip.addEventListener('click', () => onClick(chip, c));
    el.appendChild(chip);
  }
}

function applyFacets(facets) {
  if (!facets) return;
  renderFacetChips('cameraChips', null, facets.cameras, 'camera',
    searchState.camera, null,
    (chip, c) => toggleSearchFilter(chip, 'camera', c.camera));
  renderFacetChips('countryChips', null, facets.countries, 'country',
    searchState.country, null,
    (chip, c) => toggleSearchFilter(chip, 'country', c.country));
  renderFacetChips('tagChips', 'tagFilterSection', facets.tags, 'id',
    searchState.tag, searchState.tagName,
    (chip, t) => toggleTagFilter(chip, t.id, t.name));
}

function toggleTagFilter(el, id, name) {
  if (String(searchState.tag) === String(id)) { searchState.tag = ''; searchState.tagName = ''; el.classList.remove('active'); }
  else {
    document.querySelectorAll('#tagChips .chip').forEach(c => c.classList.remove('active'));
    searchState.tag = String(id); searchState.tagName = name; el.classList.add('active');
  }
  runSearch();
}

// Mobile: expand/collapse the facet panel; the count badge reflects how many
// filters are active so it's visible even while collapsed.
function toggleSearchFilters() {
  const sb = document.querySelector('.search-sidebar');
  const open = sb.classList.toggle('open');
  document.getElementById('searchFilterToggle').classList.toggle('open', open);
}
function updateFilterToggleBadge() {
  const btn = document.getElementById('searchFilterToggle');
  if (!btn) return;
  const n = document.querySelectorAll('.search-sidebar .chip.active').length;
  btn.classList.toggle('has-active', n > 0);
  document.getElementById('searchFilterCount').textContent = n;
}

// ── Virtualized search results grid ──
// Search can return hundreds of results; rendering them all at once made
// iPhone scrolling laggy/jumpy. This renders only the on-screen tiles (plus a
// small buffer) and recycles them on scroll — same approach as the library.
const svgrid = { items: [], cols: 1, cellW: 0, rowH: 0, gap: 4, rendered: new Map(),
                 totalRows: 0, gridOffset: 0, lastScrollTop: 0, rafPending: false };

function searchResetGrid() {
  const grid = document.getElementById('searchGrid');
  svgrid.items = []; svgrid.rendered.clear();
  grid.innerHTML = ''; grid.style.height = ''; grid.classList.remove('virtual');
}

function searchComputeLayout() {
  const grid = document.getElementById('searchGrid');
  const scroller = document.getElementById('searchResults');
  if (!grid || !scroller) return;
  const contentW = grid.clientWidth || (scroller.clientWidth - 40);
  const isMobile = window.matchMedia('(max-width: 760px)').matches;
  let cols;
  if (isMobile) cols = contentW < 360 ? 3 : contentW < 560 ? 4 : 5;
  else cols = Math.max(1, Math.floor((contentW + svgrid.gap) / (state.tileSize + svgrid.gap)));
  svgrid.cols = Math.max(1, cols);
  svgrid.cellW = Math.floor((contentW - (svgrid.cols - 1) * svgrid.gap) / svgrid.cols);
  svgrid.rowH = svgrid.cellW + svgrid.gap;
  svgrid.totalRows = Math.ceil(svgrid.items.length / svgrid.cols);
  grid.style.height = (svgrid.totalRows * svgrid.rowH) + 'px';
  // grid top expressed in the scroller's content coordinates (header sits above)
  svgrid.gridOffset = grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function searchPaintWindow() {
  const grid = document.getElementById('searchGrid');
  const scroller = document.getElementById('searchResults');
  if (!grid || !scroller || !svgrid.items.length) return;
  const scrollTop = scroller.scrollTop, viewH = scroller.clientHeight;
  const { cols, cellW, rowH, gap, gridOffset } = svgrid;
  const dir = scrollTop >= svgrid.lastScrollTop ? 1 : -1;
  svgrid.lastScrollTop = scrollTop;
  const ahead = viewH * 1.6, behind = viewH * 0.7;
  const winTop = scrollTop - gridOffset;
  const top = winTop - (dir > 0 ? behind : ahead);
  const bot = winTop + viewH + (dir > 0 ? ahead : behind);
  const rTop = Math.max(0, Math.floor(top / rowH));
  const rBot = Math.min(svgrid.totalRows - 1, Math.floor(bot / rowH));
  const want = new Set();
  for (let r = rTop; r <= rBot; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= svgrid.items.length) break;
      want.add(idx);
      if (!svgrid.rendered.has(idx)) {
        const tile = makeTile(svgrid.items[idx], idx, true); // immediate=true → load thumb now
        tile.style.left = (c * (cellW + gap)) + 'px';
        tile.style.top = (r * rowH) + 'px';
        tile.style.width = cellW + 'px';
        // Explicit height — iOS Safari doesn't reliably honour aspect-ratio
        // on position:absolute children, so tiles were collapsing / overlapping
        // in the search results grid on iPhone. Library uses the same fix.
        tile.style.height = cellW + 'px';
        grid.appendChild(tile);
        svgrid.rendered.set(idx, tile);
      }
    }
  }
  for (const [idx, el] of svgrid.rendered) if (!want.has(idx)) { el.remove(); svgrid.rendered.delete(idx); }
}

function searchSchedulePaint() {
  if (svgrid.rafPending) return;
  svgrid.rafPending = true;
  requestAnimationFrame(() => { svgrid.rafPending = false; searchPaintWindow(); });
}

function searchRenderResults(items) {
  const grid = document.getElementById('searchGrid');
  const scroller = document.getElementById('searchResults');
  svgrid.items = items; svgrid.rendered.clear();
  grid.classList.add('virtual');
  grid.innerHTML = '';
  if (scroller) scroller.scrollTop = 0;
  svgrid.lastScrollTop = 0;
  searchComputeLayout();
  searchPaintWindow();
}

document.getElementById('searchResults').addEventListener('scroll', searchSchedulePaint, { passive: true });
window.addEventListener('resize', () => {
  if (svgrid.items.length && document.getElementById('screen-search').classList.contains('active')) {
    searchComputeLayout(); searchPaintWindow();
  }
});

async function runSearch() {
  const icon = document.getElementById('searchIcon');
  // Effective query = committed chips + whatever's being typed (live preview).
  const typed = document.getElementById('searchInput').value.trim();
  const terms = [...searchState.terms];
  if (typed) terms.push(typed);
  const q = terms.join(' ');
  updateFilterToggleBadge();

  const params = new URLSearchParams({ limit: SEARCH_LIMIT, count: '1', facets: '1' });
  if (state.hiddenMode) {
    params.set('showHidden', '1');
  } else {
    if (q) params.set('q', q);
    // Committed chips mean an EXACT intersection (no OR/typo widening).
    if (searchState.terms.length) params.set('strict', '1');
    if (searchState.kind) params.set('kind', searchState.kind);
    if (searchState.camera) params.set('camera', searchState.camera);
    if (searchState.country) params.set('country', searchState.country);
    if (searchState.fav) params.set('fav', '1');
    if (searchState.placeIds) params.set('place', searchState.placeIds);
    // Timeline window handed over from the Places map — rides with the place.
    if (searchState.dateFrom) params.set('from', searchState.dateFrom);
    if (searchState.dateTo) params.set('to', searchState.dateTo);
    if (searchState.tag) params.set('tag', searchState.tag);
    if (state.hideRaw) params.set('hideRaw', '1');
  }

  // Active place-filter banner (includes the timeline window when set, so
  // it's obvious why older/newer photos are absent — and the ✕ clears both).
  const pf = document.getElementById('searchPlaceFilter');
  if (searchState.placeIds) {
    const span = (searchState.dateFrom || searchState.dateTo)
      ? '  ·  ' + fmtMonShort(searchState.dateFrom) + ' – ' + fmtMonShort(searchState.dateTo)
      : '';
    document.getElementById('searchPlaceFilterName').textContent = '◎ ' + searchState.placeName + span;
    pf.style.display = 'inline-flex';
  } else pf.style.display = 'none';

  const seq = ++searchSeq;
  // Cancel any in-flight prior fetch. Historically only a seq guard was
  // used, so a stale fetch STILL executed on the server — two rapid
  // Enter-presses raced on the facet TEMP table and returned corrupt
  // data. Aborting closes the connection so the server work stops too.
  if (window.__searchCtrl) { try { window.__searchCtrl.abort(); } catch (_) {} }
  window.__searchCtrl = new AbortController();
  icon.classList.add('busy');
  try {
    const res = await fetch('/api/aurora/assets?' + params, { signal: window.__searchCtrl.signal }).then(r => r.json());
    if (seq !== searchSeq) return; // superseded by a newer keystroke

    const empty = document.getElementById('searchEmpty');
    const header = document.getElementById('searchHeader');
    const cnt = document.getElementById('searchResultsCount');
    const corr = document.getElementById('searchCorrected');

    const items = res.assets || [];
    const total = res.total != null ? res.total : items.length;

    header.style.display = 'flex';
    document.getElementById('searchCount').textContent = total ? total.toLocaleString() + ' matches' : '';
    cnt.textContent = total === 0 ? 'No results'
      : total > items.length
        ? `${total.toLocaleString()} results · showing first ${items.length.toLocaleString()}`
        : `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`;
    if (res.corrected) corr.innerHTML = `Showing results for <b>${escapeHtml(res.corrected)}</b>`;
    else if (res.fuzzy && q) corr.innerHTML = `Closest matches for <b>${escapeHtml(q)}</b>`;
    else corr.textContent = '';

    // Update the sidebar chip counts to match this result set. Even on 0
    // hits we call it — the facet arrays will be empty but the active-chip
    // synthesis inside renderFacetChips keeps the user's own selection
    // visible so they can undo it.
    applyFacets(res.facets);
    updateFilterToggleBadge();

    if (!items.length) { searchResetGrid(); empty.style.display = 'flex'; state.selectList = []; return; }
    empty.style.display = 'none';

    state.lightboxItems = items;
    state.selectList = items;
    // Virtualized render — only on-screen tiles are built (smooth on mobile)
    searchRenderResults(items);
  } catch (err) {
    // Aborted by a newer keystroke — that fetch will report its own
    // outcome. Leave the panel alone.
    if (err && err.name === 'AbortError') return;
    if (seq === searchSeq) document.getElementById('searchResultsCount').textContent = 'Search failed — try again';
  } finally {
    if (seq === searchSeq) icon.classList.remove('busy');
  }
}

// ── Memories: "On this day" across past years ──
async function loadMemories() {
  try {
    const data = await fetch('/api/aurora/memories').then(r => r.json());
    const strip = document.getElementById('memoriesStrip');
    const title = document.getElementById('memoriesTitle');
    const has = data.years && data.years.length;
    title.style.display = has ? 'block' : 'none';
    strip.style.display = has ? 'flex' : 'none';
    if (!has) return;
    title.textContent = `On This Day · ${data.day}`;
    strip.innerHTML = '';
    for (const y of data.years) {
      const el = document.createElement('div');
      el.className = 'event-card memory-card';
      const img = document.createElement('img');
      img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
      img.src = thumbUrl(y.assets[0].id, 'grid');
      el.appendChild(img);
      const overlay = document.createElement('div');
      overlay.className = 'event-card-overlay';
      overlay.innerHTML = `
        <div class="event-month">${y.yearsAgo === 1 ? '1 year ago' : y.yearsAgo + ' years ago'}</div>
        <div class="event-count">${y.year} · ${y.count.toLocaleString()} ${y.count === 1 ? 'item' : 'items'}</div>`;
      el.appendChild(overlay);
      // A memory opens as a slideshow of that day straight in the lightbox
      el.addEventListener('click', () => { state.lightboxItems = y.assets; openLightbox(0); });
      strip.appendChild(el);
    }
  } catch (_) {}
}

// ── Albums ──
async function loadAlbums() {
  loadMemories();
  try {
    const data = await fetch('/api/aurora/albums').then(r => r.json());

    // My Albums (user-created)
    const mine = document.getElementById('myAlbumsGrid');
    const mineEmpty = document.getElementById('myAlbumsEmpty');
    mine.innerHTML = '';
    const userAlbums = data.user || [];
    mineEmpty.style.display = userAlbums.length ? 'none' : 'block';
    for (const al of userAlbums) {
      const el = document.createElement('div');
      el.className = 'event-card' + (al.cover_id ? '' : ' album-card-blank');
      if (al.cover_id) {
        const img = document.createElement('img');
        img.loading = 'lazy'; img.decoding = 'async';
        img.src = thumbUrl(al.cover_id, 'grid');
        el.appendChild(img);
      }
      const overlay = document.createElement('div');
      overlay.className = 'event-card-overlay';
      overlay.innerHTML = `
        <div class="event-month">${escapeHtml(al.name)}${al.share_token ? ' <span class="album-shared-dot" title="Has a public share link">⤴</span>' : ''}</div>
        <div class="event-count">${al.count.toLocaleString()} items</div>`;
      el.appendChild(overlay);
      el.addEventListener('click', () => openAlbumDetail(al.id));
      mine.appendChild(el);
    }

    // Smart albums
    const icons = { favorites: '♥', videos: '▶', recent: '◷', hidden: '🔒' };
    const iconClass = { favorites: '', videos: 'sky', recent: 'orchid', hidden: '' };
    const smartEl = document.getElementById('smartAlbums');
    smartEl.innerHTML = '';
    for (const album of data.smart) {
      const el = document.createElement('div');
      el.className = 'smart-album' + (album.id === 'hidden' ? ' album-hidden' : '');
      const countLabel = album.id === 'hidden' ? '🔒 Requires passcode' : album.count.toLocaleString() + ' items';
      el.innerHTML = `
        <div class="album-icon ${iconClass[album.id]}">${icons[album.id]}</div>
        <div>
          <div class="album-name">${album.name}</div>
          <div class="album-count">${countLabel}</div>
        </div>`;
      if (album.id === 'hidden') {
        el.addEventListener('click', () => openHiddenAlbum());
      } else {
        el.addEventListener('click', () => {
          state.kindFilter = album.query.kind || 'all';
          if (album.query.fav) state.kindFilter = 'fav';
          switchScreen('library');
          document.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.filter === state.kindFilter);
          });
          applyFilters();
        });
      }
      smartEl.appendChild(el);
    }

    // Events
    const eventsEl = document.getElementById('eventsGrid');
    eventsEl.innerHTML = '';
    for (const ev of data.events) {
      const el = document.createElement('div');
      el.className = 'event-card';
      const img = document.createElement('img');
      img.src = thumbUrl(ev.cover_id, 'grid');
      el.appendChild(img);
      const overlay = document.createElement('div');
      overlay.className = 'event-card-overlay';
      overlay.innerHTML = `
        <div class="event-month">${ev.month}</div>
        <div class="event-count">${ev.count.toLocaleString()} items</div>`;
      el.appendChild(overlay);
      // Clicking a month opens it in the Library, filtered to that date range
      el.addEventListener('click', () => openMonthInLibrary(ev.first_date, ev.last_date));
      eventsEl.appendChild(el);
    }
  } catch(_) {}
}

// ── User album detail ──
let currentAlbum = null;   // album row while the detail view is open
let albumAssets = [];

async function createAlbumPrompt() {
  const name = prompt('Album name');
  if (!name || !name.trim()) return;
  try {
    const r = await fetch('/api/aurora/albums', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    }).then(r => r.json());
    if (r.error) { toast('Failed: ' + r.error); return; }
    toast(`Album “${r.name}” created`);
    loadAlbums();
  } catch (_) { toast('Failed to create album'); }
}

async function openAlbumDetail(id) {
  try {
    const data = await fetch(`/api/aurora/albums/${id}/assets`).then(r => r.json());
    if (data.error) { toast(data.error); return; }
    currentAlbum = data.album;
    document.getElementById('albumsHome').style.display = 'none';
    const detail = document.getElementById('albumDetail');
    detail.style.display = 'block';
    detail.classList.remove('editing');
    document.getElementById('albumEditBtn').textContent = 'Edit';
    renderAlbumDetail(data.assets);
  } catch (_) { toast('Failed to open album'); }
}

function closeAlbumDetail() {
  currentAlbum = null; albumAssets = [];
  document.getElementById('albumDetail').style.display = 'none';
  document.getElementById('albumsHome').style.display = 'block';
  loadAlbums();   // refresh covers/counts after any edits
}

function renderAlbumDetail(assets) {
  albumAssets = assets;
  document.getElementById('albumDetailName').textContent = currentAlbum.name;
  const dated = assets.filter(a => a.taken_at);
  const span = dated.length
    ? `  ·  ${fmtDate(dated[0].taken_at)} – ${fmtDate(dated[dated.length - 1].taken_at)}` : '';
  document.getElementById('albumDetailMeta').textContent =
    `${assets.length.toLocaleString()} ${assets.length === 1 ? 'item' : 'items'}${span}`;
  updateAlbumShareRow();

  const grid = document.getElementById('albumGrid');
  grid.innerHTML = '';
  document.getElementById('albumEmpty').style.display = assets.length ? 'none' : 'block';
  const canManage = havePerm('albums.manage');
  assets.forEach((a, idx) => {
    const t = document.createElement('div');
    t.className = 'album-tile';
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
    img.src = thumbUrl(a.id);
    t.appendChild(img);
    if (a.kind === 'video') {
      const b = document.createElement('div'); b.className = 'tile-video-badge';
      b.textContent = a.duration_s ? '▶ ' + fmtDuration(a.duration_s) : '▶'; t.appendChild(b);
    } else if (a.live_video_id) {
      const b = document.createElement('div'); b.className = 'tile-live-badge'; b.textContent = 'LIVE'; t.appendChild(b);
    }
    if (canManage) {
      const x = document.createElement('button');
      x.className = 'album-tile-x'; x.textContent = '✕'; x.title = 'Remove from album';
      x.addEventListener('click', (e) => { e.stopPropagation(); removeFromAlbum(a.id); });
      t.appendChild(x);
      const cov = document.createElement('button');
      cov.className = 'album-tile-cov'; cov.textContent = '★'; cov.title = 'Use as album cover';
      cov.addEventListener('click', (e) => { e.stopPropagation(); setAlbumCover(a.id); });
      t.appendChild(cov);
    }
    t.addEventListener('click', () => {
      if (document.getElementById('albumDetail').classList.contains('editing')) return;
      state.lightboxItems = albumAssets;
      openLightbox(idx);
    });
    grid.appendChild(t);
  });
}

function toggleAlbumEdit() {
  const detail = document.getElementById('albumDetail');
  const on = detail.classList.toggle('editing');
  document.getElementById('albumEditBtn').textContent = on ? 'Done' : 'Edit';
}

async function removeFromAlbum(assetId) {
  if (!currentAlbum) return;
  try {
    const r = await fetch(`/api/aurora/albums/${currentAlbum.id}/assets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove: [assetId] })
    }).then(r => r.json());
    if (r.error) { toast('Failed: ' + r.error); return; }
    renderAlbumDetail(albumAssets.filter(a => a.id !== assetId));
  } catch (_) { toast('Failed to remove'); }
}

async function setAlbumCover(assetId) {
  if (!currentAlbum) return;
  try {
    const r = await fetch(`/api/aurora/albums/${currentAlbum.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverAssetId: assetId })
    }).then(r => r.json());
    if (r.error) { toast('Failed: ' + r.error); return; }
    toast('Cover updated');
  } catch (_) { toast('Failed to set cover'); }
}

async function renameAlbum() {
  if (!currentAlbum) return;
  const name = prompt('Album name', currentAlbum.name);
  if (!name || !name.trim() || name.trim() === currentAlbum.name) return;
  try {
    const r = await fetch(`/api/aurora/albums/${currentAlbum.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    }).then(r => r.json());
    if (r.error) { toast('Failed: ' + r.error); return; }
    currentAlbum.name = r.name;
    document.getElementById('albumDetailName').textContent = r.name;
  } catch (_) { toast('Failed to rename'); }
}

async function deleteAlbum() {
  if (!currentAlbum) return;
  if (!confirm(`Delete album “${currentAlbum.name}”? The photos themselves are not touched.`)) return;
  try {
    const r = await fetch(`/api/aurora/albums/${currentAlbum.id}/delete`, { method: 'POST' }).then(r => r.json());
    if (r.error) { toast('Failed: ' + r.error); return; }
    toast('Album deleted');
    closeAlbumDetail();
  } catch (_) { toast('Failed to delete'); }
}

// ── Album share link ──
function updateAlbumShareRow() {
  const row = document.getElementById('albumShareRow');
  if (currentAlbum && currentAlbum.share_token) {
    row.style.display = 'flex';
    document.getElementById('albumShareUrl').value =
      location.origin + '/share/' + currentAlbum.share_token;
  } else {
    row.style.display = 'none';
  }
}

async function toggleAlbumShare() {
  if (!currentAlbum) return;
  if (currentAlbum.share_token) { updateAlbumShareRow(); return; }
  try {
    const r = await fetch(`/api/aurora/albums/${currentAlbum.id}/share`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: true })
    }).then(r => r.json());
    if (r.error) { toast('Failed: ' + r.error); return; }
    currentAlbum.share_token = r.token;
    updateAlbumShareRow();
    toast('Share link created — anyone with the link can view this album');
  } catch (_) { toast('Failed to create share link'); }
}

async function revokeAlbumShare() {
  if (!currentAlbum || !currentAlbum.share_token) return;
  try {
    const r = await fetch(`/api/aurora/albums/${currentAlbum.id}/share`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: false })
    }).then(r => r.json());
    if (r.error) { toast('Failed: ' + r.error); return; }
    currentAlbum.share_token = null;
    updateAlbumShareRow();
    toast('Share link disabled');
  } catch (_) { toast('Failed to disable link'); }
}

function copyAlbumShare() {
  const input = document.getElementById('albumShareUrl');
  // Aurora is usually plain HTTP on a LAN, where navigator.clipboard is
  // absent — fall back to the old select+execCommand path.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(input.value).then(() => toast('Link copied'), () => legacyCopy(input));
  } else legacyCopy(input);
}
function legacyCopy(input) {
  input.focus(); input.select();
  try { document.execCommand('copy'); toast('Link copied'); }
  catch (_) { toast('Copy failed — long-press the link to copy it'); }
}

// ── Selection bar → add to album ──
async function selStartAddToAlbum() {
  if (!state.selected.size) { toast('Select some photos first'); return; }
  cancelSelEntry();
  const menu = document.getElementById('selTagMenu');
  menu.style.display = 'flex';
  menu.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Loading…</span>';
  try {
    const data = await fetch('/api/aurora/albums').then(r => r.json());
    menu.innerHTML = '<span style="font-size:11px;color:var(--text-muted);width:100%;text-align:center;">Add selection to album</span>';
    for (const al of (data.user || [])) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = escapeHtml(al.name) + `<span class="chip-count">${al.count}</span>`;
      chip.addEventListener('click', () => selAddToAlbum(al.id, al.name));
      menu.appendChild(chip);
    }
    const newChip = document.createElement('span');
    newChip.className = 'chip';
    newChip.textContent = '＋ New album…';
    newChip.addEventListener('click', async () => {
      const name = prompt('New album name');
      if (!name || !name.trim()) return;
      try {
        const r = await fetch('/api/aurora/albums', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() })
        }).then(r => r.json());
        if (r.error) { toast('Failed: ' + r.error); return; }
        selAddToAlbum(r.id, r.name);
      } catch (_) { toast('Failed to create album'); }
    });
    menu.appendChild(newChip);
  } catch (_) { menu.innerHTML = '<span style="font-size:12px;color:#f87171">Failed to load albums</span>'; }
}

async function selAddToAlbum(albumId, albumName) {
  const ids = [...state.selected];
  document.getElementById('selTagMenu').style.display = 'none';
  if (!ids.length) return;
  try {
    const r = await fetch(`/api/aurora/albums/${albumId}/assets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: ids })
    }).then(r => r.json());
    if (r.error) { toast('Failed: ' + r.error); return; }
    const skipped = ids.length - (r.added || 0);
    toast(`Added ${(r.added || 0).toLocaleString()} to “${albumName}”` + (skipped ? ` (${skipped} already there)` : ''));
  } catch (_) { toast('Failed to add to album'); }
}

// Open a date range in the Library by driving the existing time-range sliders.
function openMonthInLibrary(firstMs, lastMs) {
  // Reset the kind filter to "All" so nothing is hidden
  state.kindFilter = 'all';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));

  const maxIdx = state.totalMonths - 1;
  const clamp = (i) => Math.max(0, Math.min(maxIdx, i));
  state.fromMonth = clamp(monthIndexOf(firstMs));
  state.toMonth = clamp(monthIndexOf(lastMs));
  if (state.toMonth < state.fromMonth) state.toMonth = state.fromMonth;
  document.getElementById('timeFrom').value = state.fromMonth;
  document.getElementById('timeTo').value = state.toMonth;
  updateTimeLabel();
  switchScreen('library');
  applyFilters();
}

// ── Import: mount ──
let currentProto = 'smb';
let mountedPath = null;

function setProto(proto, btn) {
  currentProto = proto;
  document.querySelectorAll('[data-proto]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ['smb','nfs','local'].forEach(p => {
    document.getElementById('proto-' + p).style.display = p === proto ? 'block' : 'none';
  });
}

async function doMount() {
  const btn = document.getElementById('mountBtn');
  const status = document.getElementById('mountStatus');
  const fail = (msg) => { status.textContent = msg; status.style.color = '#f87171'; };
  status.textContent = ''; status.style.color = 'var(--text-muted)';

  let body = { protocol: currentProto };
  if (currentProto === 'smb') {
    body.host = document.getElementById('smbHost').value.trim();
    body.shareName = document.getElementById('smbShare').value.trim();
    body.username = document.getElementById('smbUser').value.trim();
    body.password = document.getElementById('smbPass').value;
    body.domain = document.getElementById('smbDomain').value.trim();
    if (!body.host || !body.shareName) return fail('Host and share name are required.');
  } else if (currentProto === 'nfs') {
    body.host = document.getElementById('nfsHost').value.trim();
    body.shareName = document.getElementById('nfsExport').value.trim();
    if (!body.host || !body.shareName) return fail('Host and export path are required.');
  } else {
    body.localPath = document.getElementById('localPath').value.trim();
    if (!body.localPath) return fail('Enter a server-local path.');
  }

  const done = btnBusy(btn, 'Connecting…');
  status.textContent = 'Connecting to ' + (body.host || body.localPath) + ' …';
  status.style.color = 'var(--text-muted)';
  try {
    const raw = await fetch('/api/aurora/mount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const res = await raw.json().catch(() => ({ success: false, error: `Server error ${raw.status}` }));

    if (!res.success) { fail(res.error || 'Mount failed'); done(); return; }

    mountedPath = res.mountPoint;
    document.getElementById('mountedPathDisplay').textContent = mountedPath;
    document.getElementById('mountedSourceCard').style.display = 'block';
    status.textContent = '✓ Connected — scroll down to Scan & Index';
    status.style.color = 'var(--accent-sky)';
    done('Connected ✓');
    loadMounts();
    document.getElementById('mountedSourceCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    fail('Error: ' + err.message);
    done();
  }
}

function clearMount() {
  mountedPath = null;
  document.getElementById('mountedSourceCard').style.display = 'none';
  document.getElementById('mountStatus').textContent = '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Connected shares (currently mounted) ──
async function loadMounts() {
  const card = document.getElementById('connectedSharesCard');
  const list = document.getElementById('connectedSharesList');
  try {
    const { mounts } = await fetch('/api/aurora/mounts').then(r => r.json());
    if (!mounts || !mounts.length) { card.style.display = 'none'; list.innerHTML = ''; return; }
    card.style.display = 'block';
    list.innerHTML = '';
    for (const m of mounts) {
      const type = (m.type || 'unknown').toLowerCase();
      const row = document.createElement('div');
      row.className = 'share-row';
      row.innerHTML = `
        <span class="share-badge share-badge-${type}">${escapeHtml(m.type)}</span>
        <div class="share-info">
          <div class="share-source">${escapeHtml(m.source)}</div>
          <div class="share-path">${escapeHtml(m.path)}${m.readOnly ? ' · read-only' : ''}</div>
        </div>
        <button class="btn btn-ghost share-use">Use</button>
        <button class="btn btn-ghost share-unmount">Unmount</button>`;
      row.querySelector('.share-use').addEventListener('click', () => useMount(m.path));
      row.querySelector('.share-unmount').addEventListener('click', (e) => unmountMount(m.path, e.currentTarget));
      list.appendChild(row);
    }
  } catch (_) { card.style.display = 'none'; }
}

// Reuse an already-mounted share as the scan source (no re-mount needed)
function useMount(p) {
  mountedPath = p;
  document.getElementById('mountedPathDisplay').textContent = p;
  document.getElementById('mountedSourceCard').style.display = 'block';
  toast('Source set — Scan & Index to import');
}

async function unmountMount(p, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Unmounting…'; }
  try {
    const res = await fetch('/api/aurora/unmount', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mountPoint: p })
    }).then(r => r.json());
    if (res.error) { toast('Unmount failed: ' + res.error); if (btn) { btn.disabled = false; btn.textContent = 'Unmount'; } return; }
    toast('Unmounted');
    if (mountedPath === p) clearMount();
    loadMounts();
  } catch (err) {
    toast('Unmount error: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Unmount'; }
  }
}

// ── Import ──
// Restore the Scan & Index button out of its busy/spinner state.
function resetImportBtn() {
  const b = document.getElementById('importBtn');
  if (b) { b.dataset.busy = '0'; b.disabled = false; b.innerHTML = b.dataset.origHtml || 'Scan &amp; Index'; }
}

async function startImport() {
  const path = mountedPath;
  const btn = document.getElementById('importBtn');
  if (!path) { toast('Add a source first'); return; }

  const done = btnBusy(btn, 'Starting…');
  try {
    const raw = await fetch('/api/aurora/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: path })
    });
    const res = await raw.json().catch(() => ({ error: `Server error ${raw.status}` }));

    if (res.error) { toast('Error: ' + res.error); done(); return; }

    // Keep the spinner running ("Indexing…") until the pipeline finishes.
    btn.innerHTML = '<span class="spin-dot"></span>Indexing…';
    monitorImport(res.sessionId);
  } catch (err) {
    toast('Import failed: ' + err.message);
    done();
  }
}

// Show the indexing pipeline card and stream progress for a session (shared by
// a fresh import and the Settings "Re-index metadata" action).
function monitorImport(sessionId) {
  state.importSessionId = sessionId;
  document.getElementById('importProgress').style.display = 'block';
  if (state.importSSE) state.importSSE.close();
  const es = new EventSource(`/api/aurora/import/progress/${sessionId}/stream`);
  state.importSSE = es;

  // Live-append: as photos get indexed, kick a Library refresh in chunks of
  // ~100 (throttled to at most one refresh every 3s) so the grid fills up
  // while the import runs instead of staying empty until it's done.
  let lastIndexedSeen = 0;
  let lastRefreshAt = 0;
  let refreshInFlight = false;
  const maybeLiveRefresh = async (s) => {
    if (s.status !== 'indexing' && s.status !== 'scanning') return;
    const grew = (s.indexed || 0) - lastIndexedSeen;
    const now = Date.now();
    if (grew < 100) return;
    if (now - lastRefreshAt < 3000) return;
    if (refreshInFlight) return;
    refreshInFlight = true;
    lastRefreshAt = now;
    lastIndexedSeen = s.indexed;
    try { await Promise.all([loadStats(), loadIndex()]); } catch(_) {}
    finally { refreshInFlight = false; }
  };

  es.onerror = () => {
    // SSE closed (e.g. import complete and server stopped stream) — poll once for final state
    setTimeout(async () => {
      try {
        const final = await fetch(`/api/aurora/import/progress/${sessionId}`).then(r => r.json());
        updateImportUI({ ...final, recentLog: final.log ? final.log.slice(-5) : [] });
        if (['complete', 'error', 'interrupted'].includes(final.status)) resetImportBtn();
      } catch(_) {}
    }, 500);
  };
  es.onmessage = (e) => {
    let s; try { s = JSON.parse(e.data); } catch(_) { return; }
    updateImportUI(s);
    maybeLiveRefresh(s);
    if (s.status === 'complete' || s.status === 'error' || s.status === 'interrupted') {
      es.close();
      resetImportBtn();
      loadStats(); loadIndex();
    }
  };
}

function updateImportUI(s) {
  document.getElementById('kpiScanned').textContent = s.scanned.toLocaleString();
  document.getElementById('kpiIndexed').textContent = s.indexed.toLocaleString();
  document.getElementById('kpiSkipped').textContent = s.skipped.toLocaleString();
  document.getElementById('kpiErrors').textContent = s.errors.toLocaleString();

  const pct = s.scanned ? Math.round((s.indexed + s.skipped) / s.scanned * 100) : 0;
  document.getElementById('progressBar').style.width = pct + '%';

  // Stage states
  if (s.status === 'scanning') {
    document.getElementById('stageScanning').className = 'stage active';
    document.getElementById('stageScanningStatus').textContent = 'Running…';
  } else if (s.status === 'indexing') {
    document.getElementById('stageScanning').className = 'stage done';
    document.getElementById('stageScanningStatus').textContent = s.scanned + ' files found';
    document.getElementById('stageIndexing').className = 'stage active';
    document.getElementById('stageIndexingStatus').textContent = pct + '%';
  } else if (s.status === 'complete') {
    document.getElementById('stageScanning').className = 'stage done';
    document.getElementById('stageIndexing').className = 'stage done';
    document.getElementById('stageIndexingStatus').textContent = 'Complete';
    document.getElementById('stageThumbsStatus').textContent = 'On-demand while browsing';
    document.getElementById('stageGeoStatus').textContent = 'Complete';
    toast('Import complete — ' + s.indexed.toLocaleString() + ' items indexed');
  } else if (s.status === 'error' || s.status === 'interrupted') {
    document.getElementById('stageIndexing').className = 'stage';
    document.getElementById('stageIndexingStatus').textContent =
      s.status === 'interrupted' ? 'Interrupted — re-run to resume' : 'Error';
    toast(s.status === 'interrupted'
      ? 'Import was interrupted. Re-run to resume where it stopped.'
      : 'Import error — check the log');
  }

  // Log — SSE sends only recentLog (last 5 lines), not the full array
  const feed = document.getElementById('logFeed');
  const lines = s.recentLog || (s.log ? s.log.slice(-5) : []);
  if (lines.length) {
    feed.innerHTML = '';
    for (const msg of lines) {
      const line = document.createElement('div');
      line.className = 'log-line new';
      line.textContent = '› ' + msg;
      feed.appendChild(line);
    }
    feed.scrollTop = feed.scrollHeight;
  }
}

// ── Settings sub-tabs ──
function switchSettingsTab(btn) {
  document.querySelectorAll('.settings-tabs .stab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const tab = btn.dataset.stab;
  document.querySelectorAll('.stab-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'stab-' + tab);
  });
  if (tab === 'privacy') loadPrivacyStats();
  if (tab === 'system') { loadUpdateVersion(); checkForUpdates(); }
  if (tab === 'manage') loadCaptions(); else stopCaptionPolling();
  if (tab === 'users') { loadUsers(); loadRoles(); }
  if (tab === 'audit') loadAudit();
}

// ── Photo captioning control panel (start/stop + config + live monitor) ──
let _captionPoll = null;
let _capConfigLoaded = false;

function capRelTime(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function renderCaptionState(s) {
  const startBtn = document.getElementById('capStartBtn');
  const stopBtn = document.getElementById('capStopBtn');
  if (!startBtn) return;
  const running = !!s.running;
  const stopping = s.phase === 'stopping';
  startBtn.style.display = running ? 'none' : '';
  stopBtn.style.display = running ? '' : 'none';
  startBtn.disabled = stopping;                 // can't restart mid-drain
  startBtn.textContent = stopping ? 'Stopping…' : (s.captioned && s.captioned > 0) ? 'Resume' : 'Start';

  // Progress bar — cumulative captioned / total
  const total = s.total || 0, captioned = s.captioned || 0;
  const pct = total ? Math.round((captioned / total) * 100) : 0;
  const prog = document.getElementById('capProgress');
  prog.style.display = total ? 'block' : 'none';
  document.getElementById('capProgressBar').style.width = pct + '%';
  const sessionTxt = running && s.done ? ` · ${s.done.toLocaleString()} this run` : '';
  document.getElementById('capProgressLabel').textContent =
    `${captioned.toLocaleString()} / ${total.toLocaleString()} described (${pct}%)${sessionTxt}`;

  // Status line
  const status = document.getElementById('capStatus');
  const phaseTxt = {
    running: 'Running…', starting: 'Starting…', stopping: 'Stopping…', paused: 'Paused (import running)',
    complete: '✓ All photos described', stopped: 'Stopped', error: 'Error', idle: '',
  }[s.phase] || '';
  status.textContent = s.phase === 'error' ? ('Error — ' + (s.error || 'see logs')) : phaseTxt;
  status.style.color = s.phase === 'complete' ? '#4ade80'
    : s.phase === 'error' ? '#f87171'
    : running ? 'var(--accent-sky)' : 'var(--text-muted)';

  // Live monitor — last image preview + recent activity log
  const monitor = document.getElementById('capMonitor');
  const hasActivity = (s.last && s.last.assetId) || (s.log && s.log.length);
  monitor.style.display = hasActivity ? 'block' : 'none';
  if (s.last && s.last.assetId) {
    const img = document.getElementById('capLastThumb');
    const want = `/api/aurora/thumb/${s.last.assetId}?size=grid`;
    if (img.getAttribute('data-id') !== String(s.last.assetId)) {
      img.src = want; img.setAttribute('data-id', String(s.last.assetId));
    }
    document.getElementById('capLastCap').textContent = s.last.caption || '';
    document.getElementById('capLastMeta').textContent =
      `#${s.last.assetId} · ${capRelTime(s.last.at)}`;
  }
  const logEl = document.getElementById('capLog');
  if (logEl) {
    logEl.innerHTML = '';
    for (const e of (s.log || [])) {
      const row = document.createElement('div');
      row.className = 'cap-log-row';
      const img = document.createElement('img');
      img.className = 'cap-log-thumb'; img.loading = 'lazy';
      img.src = `/api/aurora/thumb/${e.assetId}?size=grid`;
      const cap = document.createElement('div');
      cap.className = 'cap-log-cap' + (e.ok ? '' : (e.skipped ? ' skip' : ' err'));
      cap.textContent = e.ok ? (e.caption || '') : ((e.skipped ? '⊘ ' : '✕ ') + (e.error || 'failed'));
      cap.title = cap.textContent;
      const time = document.createElement('div');
      time.className = 'cap-log-time'; time.textContent = capRelTime(e.at);
      row.append(img, cap, time);
      logEl.appendChild(row);
    }
  }
}

async function loadCaptions() {
  if (!_capConfigLoaded) { await capLoadConfig(); _capConfigLoaded = true; }
  try { renderCaptionState(await fetch('/api/aurora/captions/status').then(r => r.json())); } catch (_) {}
  if (_captionPoll) return;
  _captionPoll = setInterval(async () => {
    try { renderCaptionState(await fetch('/api/aurora/captions/status').then(r => r.json())); } catch (_) {}
  }, 2500);
}
function stopCaptionPolling() { if (_captionPoll) { clearInterval(_captionPoll); _captionPoll = null; } }

async function capStart(btn) {
  btn.disabled = true;
  try { renderCaptionState(await fetch('/api/aurora/captions/status').then(r => r.json())); } catch (_) {}
  try { await fetch('/api/aurora/captions/start', { method: 'POST' }); } catch (_) {}
  btn.disabled = false;
  loadCaptions();
}
async function capStop(btn) {
  btn.disabled = true;
  try { await fetch('/api/aurora/captions/stop', { method: 'POST' }); } catch (_) {}
  btn.disabled = false;
  try { renderCaptionState(await fetch('/api/aurora/captions/status').then(r => r.json())); } catch (_) {}
}

// ── Config: populate fields, test connection, save ──
function capFillModelSelect(models, selected) {
  const sel = document.getElementById('capModel');
  if (!sel) return;
  const cur = selected || sel.value;
  sel.innerHTML = '';
  const list = (models && models.length) ? models : (cur ? [{ name: cur, vision: true }] : []);
  // vision models first
  list.sort((a, b) => (b.vision === a.vision) ? 0 : (b.vision ? 1 : -1));
  for (const m of list) {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = m.name + (m.vision ? '' : ' (no vision)') + (m.params ? ` · ${m.params}` : '');
    if (m.name === cur) o.selected = true;
    sel.appendChild(o);
  }
  if (cur && !list.some(m => m.name === cur)) {
    const o = document.createElement('option');
    o.value = cur; o.textContent = cur; o.selected = true;
    sel.insertBefore(o, sel.firstChild);
  }
}

async function capLoadConfig() {
  try {
    const cfg = await fetch('/api/aurora/captions/config').then(r => r.json());
    document.getElementById('capUrl').value = cfg.url || '';
    document.getElementById('capConc').value = String(cfg.concurrency || 1);
    const styleSel = document.getElementById('capStyle');
    styleSel.innerHTML = '';
    for (const st of (cfg.styles || [])) {
      const o = document.createElement('option');
      o.value = st.key; o.textContent = st.label;
      if (st.key === cfg.style) o.selected = true;
      styleSel.appendChild(o);
    }
    capFillModelSelect(null, cfg.model);
    // best-effort: fetch live model list from the saved server
    capTestConnection(null, true);
  } catch (_) {}
}

async function capTestConnection(btn, quiet) {
  const hint = document.getElementById('capModelHint');
  const url = document.getElementById('capUrl').value.trim();
  if (btn) btn.disabled = true;
  if (!quiet && hint) { hint.textContent = 'Testing…'; hint.style.color = 'var(--text-faint)'; }
  try {
    const r = await fetch('/api/aurora/captions/models?url=' + encodeURIComponent(url)).then(r => r.json());
    if (r.ok) {
      const vis = r.models.filter(m => m.vision).length;
      capFillModelSelect(r.models, document.getElementById('capModel').value);
      if (hint) { hint.textContent = `✓ Connected · ${r.models.length} models (${vis} vision)`; hint.style.color = '#4ade80'; }
    } else {
      if (hint) { hint.textContent = '✕ ' + (r.error || 'unreachable'); hint.style.color = '#f87171'; }
    }
  } catch (e) {
    if (hint) { hint.textContent = '✕ ' + (e.message || 'failed'); hint.style.color = '#f87171'; }
  }
  if (btn) btn.disabled = false;
}

async function capSaveConfig(btn) {
  const st = document.getElementById('capSaveStatus');
  btn.disabled = true; st.textContent = 'Saving…'; st.style.color = 'var(--text-muted)';
  const body = {
    url: document.getElementById('capUrl').value.trim(),
    model: document.getElementById('capModel').value,
    style: document.getElementById('capStyle').value,
    concurrency: parseInt(document.getElementById('capConc').value) || 1,
  };
  try {
    await fetch('/api/aurora/captions/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    st.textContent = '✓ Saved'; st.style.color = '#4ade80';
  } catch (_) {
    st.textContent = '✕ Failed'; st.style.color = '#f87171';
  }
  btn.disabled = false;
  setTimeout(() => { st.textContent = ''; }, 2500);
}

// ── Settings ──
async function loadSettings(btn) {
  const done = btnBusy(btn, 'Refreshing…');
  // If the current active sub-tab is hidden for this user, jump to the
  // first visible one so they don't land on an empty screen.
  const activeTab = document.querySelector('.settings-tabs .stab.active');
  if (activeTab && activeTab.offsetParent === null) {
    const firstVisible = [].slice.call(document.querySelectorAll('.settings-tabs .stab'))
      .find(b => b.offsetParent !== null);
    if (firstVisible) switchSettingsTab(firstVisible);
  }
  loadMounts();
  loadTagManager();
  const rawCb = document.getElementById('toggleHideRaw');
  if (rawCb) rawCb.checked = state.hideRaw;
  try {
    const m = await fetch('/api/aurora/settings/metrics').then(r => r.json());
    const lib = m.library || {}, th = m.thumbnails || {}, im = m.imports || {}, warm = (th.warm || {});

    const card = (title, rows) => `
      <div class="settings-card">
        <div class="settings-card-title">${title}</div>
        ${rows.map(([k, v]) => `<div class="settings-row"><span>${k}</span><span class="settings-val">${v}</span></div>`).join('')}
      </div>`;
    const dateRange = (lib.earliest && lib.latest) ? `${fmtDate(lib.earliest)} – ${fmtDate(lib.latest)}` : '—';
    const warmPct = warm.total ? Math.round((warm.done / warm.total) * 100) : 0;
    const warmLabel = (warm.phase && warm.phase !== 'idle') ? `${warm.phase} · ${warmPct}%` : 'idle';

    document.getElementById('settingsMetrics').innerHTML =
      card('Library', [
        ['Total items', (lib.total || 0).toLocaleString()],
        ['Photos', (lib.photos || 0).toLocaleString()],
        ['Videos', (lib.videos || 0).toLocaleString()],
        ['Live Photos', (lib.live_photos || 0).toLocaleString()],
        ['Favorites', (lib.favorites || 0).toLocaleString()],
        ['Undated', (lib.undated || 0).toLocaleString()],
        ['Places', (lib.places || 0).toLocaleString()],
        ['Date range', dateRange],
        ...(lib.hidden ? [['Hidden (private)', lib.hidden.toLocaleString()]] : []),
        ...(lib.duplicates_hidden ? [['Duplicates hidden', lib.duplicates_hidden.toLocaleString()]] : []),
        ...(lib.removed ? [['Removed', lib.removed.toLocaleString()]] : []),
      ]) +
      card('Storage', [
        ['Originals', fmtBytes(lib.total_bytes)],
        ['Database', fmtBytes(lib.db_bytes)],
        ['Thumbnails (approx)', fmtBytes(th.bytes_approx)],
        ['Thumbnail files', (th.count || 0).toLocaleString()],
      ]) +
      card('Thumbnails', [
        ['Status', warmLabel],
        ['Generated this run', (warm.generated || 0).toLocaleString()],
        ['Cached', (th.count || 0).toLocaleString()],
      ]) +
      card('Errors', [
        ['Import errors', (im.total_errors || 0).toLocaleString()],
        ['Interrupted imports', (im.interrupted || 0).toLocaleString()],
      ]);

    const rct = document.getElementById('removedCountTag');
    if (rct) rct.textContent = lib.removed ? ` · ${lib.removed.toLocaleString()}` : '';

    // Recent imports
    const imp = document.getElementById('settingsImports');
    if (im.recent && im.recent.length) {
      imp.innerHTML = '';
      for (const s of im.recent) {
        const badge = s.status === 'complete' ? 'smb' : s.status === 'error' ? 'unknown' : 'nfs';
        const when = s.started_at ? fmtDate(s.started_at) : '—';
        const row = document.createElement('div');
        row.className = 'share-row';
        row.innerHTML = `
          <span class="share-badge share-badge-${badge}">${escapeHtml(s.status)}</span>
          <div class="share-info">
            <div class="share-source">${escapeHtml(s.source_path)}</div>
            <div class="share-path">${when} · ${(s.indexed || 0).toLocaleString()} indexed · ${(s.skipped || 0).toLocaleString()} skipped · ${(s.errors || 0)} errors</div>
          </div>`;
        imp.appendChild(row);
      }
    } else {
      imp.innerHTML = '<span style="font-size:12px;color:var(--text-faint)">No imports yet</span>';
    }

    // Re-index buttons for currently-mounted shares
    const rs = document.getElementById('reindexSources');
    try {
      const { mounts } = await fetch('/api/aurora/mounts').then(r => r.json());
      if (mounts && mounts.length) {
        rs.innerHTML = '';
        for (const mt of mounts) {
          const row = document.createElement('div');
          row.className = 'share-row';
          row.innerHTML = `
            <span class="share-badge share-badge-${(mt.type || 'unknown').toLowerCase()}">${escapeHtml(mt.type)}</span>
            <div class="share-info"><div class="share-path">${escapeHtml(mt.path)}</div></div>
            <button class="btn btn-ghost">Re-index</button>`;
          row.querySelector('button').addEventListener('click', (e) => settingsReindex(mt.path, e.currentTarget));
          rs.appendChild(row);
        }
      } else {
        rs.innerHTML = '<span style="font-size:12px;color:var(--text-faint)">No shares mounted — add a source above, then re-index it here.</span>';
      }
    } catch(_) {}
    done('Refreshed ✓');
  } catch(_) {
    document.getElementById('settingsMetrics').innerHTML =
      '<div style="color:#f87171;font-size:13px;">Failed to load metrics</div>';
    done();
  }
}

// ── Tag manager (Settings) ──
async function loadTagManager() {
  const el = document.getElementById('tagManager');
  if (!el) return;
  try {
    const tags = await fetch('/api/aurora/tags').then(r => r.json());
    if (!tags.length) {
      el.innerHTML = '<span style="font-size:12px;color:var(--text-faint)">No tags yet. Add tags from a photo’s Info panel, or with Select on the Library screen.</span>';
      return;
    }
    el.innerHTML = '';
    for (const t of tags) {
      const row = document.createElement('div');
      row.className = 'share-row';
      row.innerHTML = `
        <div class="share-info">
          <div class="share-source">${escapeHtml(t.name)}</div>
          <div class="share-path">${t.count.toLocaleString()} photo${t.count === 1 ? '' : 's'}</div>
        </div>
        <button class="btn btn-ghost tagm-rename">Rename</button>
        <button class="btn btn-ghost tagm-delete">Delete</button>`;
      row.querySelector('.tagm-rename').addEventListener('click', () => tagRename(t.id, t.name, row));
      row.querySelector('.tagm-delete').addEventListener('click', (e) => tagDelete(t.id, t.name, e.currentTarget));
      el.appendChild(row);
    }
  } catch (_) { el.innerHTML = '<span style="font-size:12px;color:#f87171">Failed to load tags</span>'; }
}

function tagRename(tagId, current, row) {
  const info = row.querySelector('.share-info');
  info.innerHTML = `<input class="tagm-input" maxlength="80" style="width:100%;background:rgba(255,255,255,0.08);border:1px solid var(--accent);border-radius:6px;color:var(--text);font-family:inherit;font-size:13px;padding:6px 8px;outline:none;">`;
  const input = info.querySelector('input');
  input.value = current; input.focus(); input.select();
  row.querySelectorAll('button').forEach(b => b.remove());
  const save = document.createElement('button'); save.className = 'btn'; save.textContent = 'Save';
  const cancel = document.createElement('button'); cancel.className = 'btn btn-ghost'; cancel.textContent = 'Cancel';
  row.appendChild(save); row.appendChild(cancel);
  const doSave = async () => {
    const name = (input.value || '').trim();
    if (!name || name === current) { loadTagManager(); return; }
    save.disabled = true; save.textContent = 'Saving…';
    try {
      const r = await fetch('/api/aurora/tags/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tagId, name })
      }).then(r => r.json());
      if (r.error) toast('Rename failed: ' + r.error);
      else toast(r.merged ? `Merged into “${name}”` : `Renamed to “${name}”`);
    } catch (_) { toast('Rename failed'); }
    loadTagManager();
  };
  save.addEventListener('click', doSave);
  cancel.addEventListener('click', () => loadTagManager());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } else if (e.key === 'Escape') loadTagManager(); });
}

async function tagDelete(tagId, name, btn) {
  if (!confirm(`Delete the tag “${name}”? It will be removed from all photos (the photos themselves are kept).`)) return;
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    await fetch('/api/aurora/tags/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tagId })
    });
    toast(`Deleted “${name}”`);
  } catch (_) { toast('Delete failed'); }
  loadTagManager();
}

// Hide/show RAW stills (they can't be decoded for preview). Persisted per-browser.
function setHideRaw(on) {
  state.hideRaw = !!on;
  try { localStorage.setItem('aurora_hideRaw', on ? '1' : '0'); } catch (_) {}
  loadIndex(); // re-fetch the library with/without RAW
  toast(on ? 'RAW photos hidden' : 'RAW photos shown');
}

async function settingsWarm(btn) {
  const done = btnBusy(btn, 'Starting…');
  setActionStatus('Starting thumbnail warming…');
  try {
    await fetch('/api/aurora/warm', { method: 'POST' });
    setActionStatus('✓ Thumbnail warming started in the background.', 'ok');
    done('Started ✓');
    startWarmPoll();
  } catch (e) { setActionStatus('Failed: ' + e.message, 'err'); done(); }
}

async function settingsWarmStop(btn) {
  const done = btnBusy(btn, 'Stopping…');
  try {
    await fetch('/api/aurora/warm/stop', { method: 'POST' });
    setActionStatus('Thumbnail warming is winding down…', 'ok');
    done();
    startWarmPoll();
  } catch (e) { setActionStatus('Failed: ' + e.message, 'err'); done(); }
}

async function settingsWarmBootPref(chk) {
  try {
    const r = await fetch('/api/aurora/warm/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warmOnBoot: chk.checked })
    }).then(r => r.json());
    if (r.error) { toast('Failed: ' + r.error); chk.checked = !chk.checked; return; }
    toast(r.warmOnBoot ? 'Warming will auto-start after restarts' : 'Auto-warming after restart disabled');
  } catch (_) { toast('Failed to save'); chk.checked = !chk.checked; }
}

// Poll warm status while the warmer runs so the Maintenance card shows live
// progress and the Stop button appears/disappears at the right times. The
// poller only runs while the Settings screen is visible and stops itself
// once the sweep is idle/complete.
let warmPollTimer = null;
async function refreshWarmStatus() {
  try {
    const w = await fetch('/api/aurora/warm/status').then(r => r.json());
    const line = document.getElementById('warmProgressLine');
    const stopBtn = document.getElementById('btnWarmStop');
    const chk = document.getElementById('warmOnBootChk');
    if (chk && typeof w.warmOnBoot === 'boolean') chk.checked = w.warmOnBoot;
    if (w.running) {
      stopBtn.style.display = '';
      line.style.display = '';
      const pct = w.total ? Math.round((w.done / w.total) * 100) : 0;
      line.textContent = `Warming ${w.phase}: ${w.done.toLocaleString()} / ${w.total.toLocaleString()} scanned (${pct}%) · ${w.generated.toLocaleString()} generated this run`;
      return true;
    }
    stopBtn.style.display = 'none';
    if (w.phase === 'stopped') { line.style.display = ''; line.textContent = `Warming stopped — ${w.generated.toLocaleString()} generated this run. Start again any time; it resumes where it left off.`; }
    else if (w.phase === 'complete') { line.style.display = ''; line.textContent = `Warming complete — ${w.generated.toLocaleString()} generated in the last run.`; }
    else line.style.display = 'none';
    return false;
  } catch (_) { return false; }
}
function startWarmPoll() {
  clearInterval(warmPollTimer);
  warmPollTimer = setInterval(async () => {
    const settingsVisible = document.getElementById('screen-settings').classList.contains('active');
    if (!settingsVisible) { clearInterval(warmPollTimer); warmPollTimer = null; return; }
    const running = await refreshWarmStatus();
    if (!running) { clearInterval(warmPollTimer); warmPollTimer = null; }
  }, 2500);
  refreshWarmStatus();
}

async function settingsRelink(btn) {
  const done = btnBusy(btn, 'Re-linking…');
  setActionStatus('Re-linking Live Photos…');
  try {
    const r = await fetch('/api/aurora/settings/relink-live', { method: 'POST' }).then(r => r.json());
    const linked = (r.linked || 0).toLocaleString();
    const cleared = r.cleared || 0;
    const rejected = r.rejectedByTime || 0;
    // Two parts of the story deserve surfacing:
    // - cleared: pairs undone from the prior DB state (only nonzero on the
    //   first run after a bad-pairing algorithm was replaced; 0 on repeat
    //   clicks because the algorithm is deterministic).
    // - rejectedByTime: name-matches whose still/clip capture times are >5s
    //   apart (iOS filename recycling — e.g. IMG_1190.jpg from 2019 + a MOV
    //   with the same base name from 2021). Reported every run so the user
    //   can see the timestamp gate is doing something.
    const bits = [];
    if (cleared > 0) bits.push(`unlinked ${cleared.toLocaleString()} stale pair${cleared === 1 ? '' : 's'}`);
    if (rejected > 0) bits.push(`skipped ${rejected.toLocaleString()} timestamp mismatch${rejected === 1 ? '' : 'es'}`);
    const suffix = bits.length ? '  (' + bits.join(', ') + ')' : '';
    setActionStatus(`✓ Linked ${linked} Live Photos.${suffix}`, 'ok');
    done('Done ✓');
    loadStats(); loadIndex();
  } catch (e) { setActionStatus('Failed: ' + e.message, 'err'); done(); }
}

async function settingsGeocode(btn) {
  const done = btnBusy(btn, 'Naming places…');
  setActionStatus('Resolving place names from the offline cities dataset…');
  try {
    const r = await fetch('/api/aurora/settings/geocode-places', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(r => r.json());
    if (r.error) { setActionStatus('Failed: ' + r.error, 'err'); done(); return; }
    setActionStatus(`✓ Named ${(r.named || 0).toLocaleString()} of ${(r.processed || 0).toLocaleString()} places. Open Places to see them on the map.`, 'ok');
    done('Done ✓');
    loadStats(); // the Places map re-fetches names on its next visit
  } catch (e) { setActionStatus('Failed: ' + e.message, 'err'); done(); }
}

async function settingsReindex(p, btn) {
  const done = btnBusy(btn, 'Starting…');
  setActionStatus('Re-indexing ' + p + ' …');
  try {
    const r = await fetch('/api/aurora/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: p, force: true })
    }).then(r => r.json());
    if (r.error) { setActionStatus('Failed: ' + r.error, 'err'); done(); return; }
    setActionStatus('✓ Re-index started — progress is shown below.', 'ok');
    done('Started ✓');
    monitorImport(r.sessionId);
    document.getElementById('importProgress').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { setActionStatus('Failed: ' + e.message, 'err'); done(); }
}

// ── Software update ──────────────────────────────────────────────────────
//
// The System tab shows the current build, the latest GitHub release, and
// the changelog. One click ("Update now") downloads the update-zip
// asset from the release and hands it to the same server-side applier
// used by the local-zip fallback (which rolls back on failure and never
// touches DATA_DIR).
let updatePoller = null;
let updateLatest = null;

async function loadUpdateVersion() {
  try {
    const v = await fetch('/api/aurora/version').then(r => r.json());
    const el = document.getElementById('updateVersionLine');
    if (el) el.textContent = `Current version: ${v.version}  (built ${v.build || '—'})`;
    const tag = document.getElementById('settingsVersionTag');
    if (tag) tag.textContent = 'v' + v.version;
  } catch (_) {}
}

function setUpdateStatus(msg, kind) {
  const el = document.getElementById('updateStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'update-status visible ' + (kind || 'info');
}

// Very small Markdown renderer for GitHub release bodies — headings,
// bullets, bold/italic, inline code, links. Enough for a readable
// changelog without pulling a full markdown library into the SPA.
function mdEscape(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
}
function renderChangelog(md) {
  if (!md) return '<em style="color:var(--text-muted)">No release notes provided.</em>';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inList = false;
  const inline = (t) => mdEscape(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    const li = line.match(/^\s*[-*]\s+(.+)$/);
    if (h) {
      if (inList) { out.push('</ul>'); inList = false; }
      const level = Math.min(4, h[1].length + 2);
      out.push(`<h${level} style="margin:10px 0 4px;font-size:${16 - h[1].length}px;">${inline(h[2])}</h${level}>`);
    } else if (li) {
      if (!inList) { out.push('<ul style="margin:6px 0 6px 20px;padding:0;">'); inList = true; }
      out.push(`<li style="margin-bottom:3px;">${inline(li[1])}</li>`);
    } else if (!line) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div style="height:6px;"></div>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<div>${inline(line)}</div>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

async function checkForUpdates() {
  const btn = document.getElementById('updateCheckBtn');
  const summary = document.getElementById('updateSummary');
  const statusLine = document.getElementById('updateCheckStatus');
  const applyBtn = document.getElementById('updateApplyBtn');
  const linkBtn = document.getElementById('updateReleaseLink');
  const clWrap = document.getElementById('updateChangelogWrap');
  if (btn) btn.disabled = true;
  summary.className = 'update-summary';
  statusLine.textContent = 'Checking GitHub for the latest release…';
  applyBtn.style.display = 'none';
  linkBtn.style.display = 'none';
  clWrap.style.display = 'none';
  try {
    const r = await fetch('/api/aurora/settings/update/check');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Check failed');
    updateLatest = data.latest;
    const curV = (data.current && data.current.version) || '?';
    const latV = (data.latest && data.latest.version) || '?';
    if (data.updateAvailable && data.assetAvailable) {
      summary.className = 'update-summary available';
      statusLine.innerHTML = `Update available: <strong>v${escapeHtml(latV)}</strong> <span class="badge new">NEW</span>` +
        `<div class="update-detail">Installed: v${escapeHtml(curV)} · ${data.latest.assetName || ''}` +
        (data.latest.assetSize ? ` · ${(data.latest.assetSize/1024/1024).toFixed(1)} MB` : '') +
        (data.latest.publishedAt ? ` · published ${new Date(data.latest.publishedAt).toLocaleDateString()}` : '') +
        `</div>`;
      applyBtn.style.display = '';
      applyBtn.disabled = false;
    } else if (data.updateAvailable && !data.assetAvailable) {
      summary.className = 'update-summary err';
      statusLine.innerHTML = `Latest release <strong>v${escapeHtml(latV)}</strong> has no update-zip asset yet. Try again in a few minutes, or install from a local zip below.`;
    } else {
      summary.className = 'update-summary uptodate';
      statusLine.innerHTML = `You're up to date <span class="badge ok">v${escapeHtml(curV)}</span>` +
        `<div class="update-detail">Latest release: v${escapeHtml(latV)}</div>`;
    }
    if (data.latest && data.latest.htmlUrl) {
      linkBtn.href = data.latest.htmlUrl;
      linkBtn.style.display = '';
    }
    if (data.latest && data.latest.changelog) {
      document.getElementById('updateChangelog').innerHTML = renderChangelog(data.latest.changelog);
      clWrap.style.display = '';
      if (data.updateAvailable) clWrap.open = true;
    }
  } catch (e) {
    summary.className = 'update-summary err';
    statusLine.textContent = 'Could not check for updates: ' + e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function applyGitHubUpdate() {
  if (!updateLatest) return;
  if (!confirm(`Install Aurora Photos v${updateLatest.version}?\n\nThe service will restart. Your library and settings are preserved, and a rollback snapshot is taken automatically so a failed update reverts to the current version.`)) return;
  const btn = document.getElementById('updateApplyBtn');
  btn.disabled = true;
  setUpdateStatus('Downloading update from GitHub…', 'info');
  try {
    const r = await fetch('/api/aurora/settings/update/apply-github', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await r.json();
    if (!r.ok) { setUpdateStatus('Error: ' + (data.error || 'Update failed'), 'err'); btn.disabled = false; return; }
    setUpdateStatus(data.message || 'Update triggered…', 'info');
    startUpdatePoller();
  } catch (e) {
    setUpdateStatus('Request failed: ' + e.message, 'err');
    btn.disabled = false;
  }
}

async function applyUpdate() {
  const zipPath = (document.getElementById('updateZipPath').value || '').trim();
  if (!zipPath) { setUpdateStatus('Please enter the full path to the update zip file.', 'err'); return; }

  const btn = document.getElementById('updateApplyLocalBtn');
  btn.disabled = true;
  setUpdateStatus('Sending update request…', 'info');

  try {
    const r = await fetch('/api/aurora/settings/update/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zipPath })
    }).then(r => r.json());

    if (r.error) { setUpdateStatus('Error: ' + r.error, 'err'); btn.disabled = false; return; }

    setUpdateStatus(r.message || 'Update triggered…', 'info');
    startUpdatePoller();
  } catch (e) {
    setUpdateStatus('Request failed: ' + e.message, 'err');
    btn.disabled = false;
  }
}

function startUpdatePoller() {
  if (updatePoller) clearInterval(updatePoller);
  updatePoller = setInterval(async () => {
    try {
      const s = await fetch('/api/aurora/settings/update/status').then(r => r.json());
      const msg = s.message || s.status || '';

      if (s.status === 'complete') {
        clearInterval(updatePoller); updatePoller = null;
        setUpdateStatus('✓ ' + msg + ' — clearing cache and reloading…', 'ok');
        const gb = document.getElementById('updateApplyBtn'); if (gb) gb.disabled = false;
        const lb = document.getElementById('updateApplyLocalBtn'); if (lb) lb.disabled = false;
        // hardReload() drops every cache + unregisters the SW BEFORE
        // reloading — a plain location.reload() left the old page shell,
        // stale JS and cached /me response in place, so the user was
        // "still on" the old version until they manually cleared cache.
        setTimeout(() => hardReload(), 1500);
      } else if (s.status === 'error') {
        clearInterval(updatePoller); updatePoller = null;
        setUpdateStatus('✗ ' + msg, 'err');
        const gb = document.getElementById('updateApplyBtn'); if (gb) gb.disabled = false;
        const lb = document.getElementById('updateApplyLocalBtn'); if (lb) lb.disabled = false;
      } else if (s.status === 'rolled_back') {
        clearInterval(updatePoller); updatePoller = null;
        setUpdateStatus('⤺ ' + msg, 'err');
        const gb = document.getElementById('updateApplyBtn'); if (gb) gb.disabled = false;
        const lb = document.getElementById('updateApplyLocalBtn'); if (lb) lb.disabled = false;
      } else if (s.status !== 'idle') {
        setUpdateStatus(msg || 'Updating…', 'info');
      }
    } catch (_) {
      // Server may be down mid-restart — keep polling silently
      setUpdateStatus('Waiting for service to come back up…', 'info');
    }
  }, 1500);
}

// Auto-resume polling if the page loads during an in-progress update
(function checkPendingUpdate() {
  fetch('/api/aurora/settings/update/status').then(r => r.json()).then(s => {
    if (s.status && s.status !== 'idle' && s.status !== 'complete' && s.status !== 'error') {
      setUpdateStatus(s.message || 'Update in progress…', 'info');
      startUpdatePoller();
    }
  }).catch(() => {});
})();

// ── Passcode / Private photos ──────────────────────────────────────────────

let _passcodeCb = null;

function showPasscodeModal(subtitle, cb) {
  _passcodeCb = cb;
  document.getElementById('passcodeSubtitle').textContent = subtitle || 'Enter your passcode to continue';
  document.getElementById('passcodeInput').value = '';
  document.getElementById('passcodeErr').textContent = '';
  document.getElementById('passcodeOverlay').style.display = 'flex';
  setTimeout(() => document.getElementById('passcodeInput').focus(), 80);
}

function passcodeCancel() {
  document.getElementById('passcodeOverlay').style.display = 'none';
  _passcodeCb = null;
}

async function passcodeSubmit() {
  const code = document.getElementById('passcodeInput').value;
  const errEl = document.getElementById('passcodeErr');
  const input = document.getElementById('passcodeInput');
  try {
    const r = await fetch('/api/aurora/settings/passcode/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: code })
    }).then(r => r.json());
    if (r.ok) {
      state.privateUnlocked = true;
      document.getElementById('passcodeOverlay').style.display = 'none';
      const cb = _passcodeCb; _passcodeCb = null;
      if (cb) cb();
    } else {
      errEl.textContent = 'Incorrect passcode';
      input.style.animation = 'shake 0.35s';
      setTimeout(() => { input.style.animation = ''; input.value = ''; input.focus(); }, 350);
    }
  } catch (_) { errEl.textContent = 'Connection error — try again'; }
}

document.getElementById('passcodeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); passcodeSubmit(); }
  if (e.key === 'Escape') passcodeCancel();
});

// Change passcode from Settings → Privacy tab
async function changePasscode() {
  const np = (document.getElementById('newPasscode').value || '').trim();
  const cp = (document.getElementById('confirmPasscode').value || '').trim();
  const st = document.getElementById('passcodeSetStatus');
  if (!np) { st.textContent = 'Enter a new passcode'; st.style.color = '#f87171'; return; }
  if (np !== cp) { st.textContent = 'Passcodes do not match'; st.style.color = '#f87171'; return; }
  try {
    await fetch('/api/aurora/settings/passcode/set', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: np })
    });
    st.textContent = '✓ Passcode updated'; st.style.color = '#4ade80';
    document.getElementById('newPasscode').value = '';
    document.getElementById('confirmPasscode').value = '';
    setTimeout(() => { st.textContent = ''; }, 3000);
  } catch (_) { st.textContent = 'Failed to save passcode'; st.style.color = '#f87171'; }
}

// Privacy stats for the Privacy tab
async function loadPrivacyStats() {
  const el = document.getElementById('privacyStats');
  if (!el) return;
  try {
    const s = await fetch('/api/aurora/settings/privacy/stats').then(r => r.json());
    el.innerHTML = `
      <div class="settings-row"><span>Hidden photos</span><span class="settings-val">${(s.hidden || 0).toLocaleString()}</span></div>
      <div class="settings-row"><span>Duplicates hidden</span><span class="settings-val">${(s.duplicates_hidden || 0).toLocaleString()}</span></div>`;
  } catch (_) { if (el) el.textContent = '—'; }
}

// Hide/unhide a single photo from the info panel
async function togglePrivatePhoto(id, currentlyHidden) {
  const hidden = currentlyHidden ? 0 : 1;
  try {
    await fetch('/api/aurora/assets/privacy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: [id], hidden })
    });
    toast(hidden ? 'Photo hidden' : 'Photo unhidden');
    // Reload info panel to reflect new state
    loadMetaPanel(id);
    if (hidden) {
      // Remove from current grid view immediately
      closeLightbox();
      if (state.hiddenMode) {
        // Stay in hidden mode, just refresh
        runSearch();
      } else {
        loadIndex();
      }
    } else {
      loadIndex();
    }
  } catch (_) { toast('Failed to update photo'); }
}

// Soft-remove one asset from the library (kept on disk, reversible in Settings).
async function removeAssetFromLibrary(id) {
  if (!confirm('Remove this from your library?\n\nIt will be hidden everywhere and won\'t re-import, but the original file is kept and you can restore it from Settings → Manage removed.')) return;
  try {
    const r = await fetch('/api/aurora/assets/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: [id] })
    }).then(r => r.json());
    if (r.error) { toast('Remove failed: ' + r.error); return; }
    toast('Removed from library');
    closeLightbox();
    loadStats();
    if (state.hiddenMode) runSearch(); else loadIndex();
  } catch (_) { toast('Failed to remove'); }
}

// ── Manage removed (undo soft-remove) ──
async function openRemovedManager() {
  const ov = document.getElementById('removedOverlay');
  ov.style.display = 'flex';
  document.getElementById('removedSub').textContent = 'Loading…';
  document.getElementById('removedList').innerHTML = '';
  await refreshRemovedList();
}
function closeRemovedManager() { document.getElementById('removedOverlay').style.display = 'none'; }
async function refreshRemovedList() {
  const listEl = document.getElementById('removedList');
  const subEl = document.getElementById('removedSub');
  try {
    const r = await fetch('/api/aurora/assets/removed').then(r => r.json());
    const rows = (r && r.removed) || [];
    subEl.textContent = rows.length
      ? `${rows.length} removed item${rows.length === 1 ? '' : 's'} · originals kept on disk`
      : 'Nothing has been removed.';
    listEl.innerHTML = rows.length ? '' : '<div class="removed-empty">No removed items. Anything you remove from the library shows up here so you can undo it.</div>';
    for (const a of rows) {
      const row = document.createElement('div');
      row.className = 'removed-row';
      const info = document.createElement('div');
      info.className = 'removed-row-info';
      const name = document.createElement('div');
      name.className = 'removed-row-name';
      name.textContent = (a.kind === 'video' ? '🎞 ' : '🖼 ') + (a.filename || 'Unknown');
      const p = document.createElement('div');
      p.className = 'removed-row-path';
      p.textContent = a.path || '';
      p.title = a.path || '';
      info.appendChild(name); info.appendChild(p);
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.style.fontSize = '12px';
      btn.textContent = 'Restore';
      btn.addEventListener('click', () => restoreRemoved(a.id, btn));
      row.appendChild(info); row.appendChild(btn);
      listEl.appendChild(row);
    }
  } catch (_) {
    subEl.textContent = 'Failed to load removed items.';
  }
}
async function restoreRemoved(id, btn) {
  const done = btnBusy(btn, 'Restoring…');
  try {
    const r = await fetch('/api/aurora/assets/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: [id] })
    }).then(r => r.json());
    if (r.error) { toast('Restore failed: ' + r.error); done(); return; }
    toast('Restored to library');
    await refreshRemovedList();
    loadStats(); loadIndex();
  } catch (_) { toast('Restore failed'); done(); }
}

// Soft-remove the current multi-selection.
async function selRemovePhotos() {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (!confirm(`Remove ${ids.length} item${ids.length === 1 ? '' : 's'} from your library?\n\nThey'll be hidden everywhere and won't re-import, but the originals are kept and you can restore them from Settings → Manage removed.`)) return;
  try {
    const r = await fetch('/api/aurora/assets/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: ids })
    }).then(r => r.json());
    if (r.error) { toast('Remove failed: ' + r.error); return; }
    toast(`${ids.length} removed from library`);
    exitSelectMode();
    loadStats();
    loadIndex();
  } catch (_) { toast('Failed to remove'); }
}

// Hide the current selection
async function selHidePhotos() {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    await fetch('/api/aurora/assets/privacy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: ids, hidden: 1 })
    });
    toast(`${ids.length} photo${ids.length === 1 ? '' : 's'} hidden`);
    exitSelectMode();
    loadIndex();
  } catch (_) { toast('Failed to hide photos'); }
}

// Open the hidden album (requires passcode if not unlocked)
function openHiddenAlbum() {
  if (state.privateUnlocked) {
    enterHiddenMode();
  } else {
    showPasscodeModal('Enter your passcode to view hidden photos', () => enterHiddenMode());
  }
}

function enterHiddenMode() {
  state.hiddenMode = true;
  switchScreen('search');
  document.getElementById('hiddenBanner').style.display = 'flex';
  document.querySelector('.search-sidebar').style.display = 'none';
  document.getElementById('searchInput').value = '';
  runSearch();
}

function exitHiddenMode() {
  state.hiddenMode = false;
  document.getElementById('hiddenBanner').style.display = 'none';
  document.querySelector('.search-sidebar').style.display = '';
  runSearch();
}

// ── Duplicate detection ─────────────────────────────────────────────────────

let _dupPoll = null;

// Re-encoded / Live Photo copies: same photo saved twice at different
// compression. Server groups by metadata signature and auto-resolves, always
// keeping the Live Photo copy. Fast (pure DB), so no progress polling needed.
async function startSimilarScan() {
  const btn = document.getElementById('dupSimilarBtn');
  const statusEl = document.getElementById('dupSimilarStatus');
  btn.disabled = true; btn.textContent = 'Scanning…';
  statusEl.textContent = 'Looking for re-encoded copies…'; statusEl.style.color = 'var(--text-muted)';
  try {
    const r = await fetch('/api/aurora/settings/duplicates/scan-similar', { method: 'POST' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    if (!r.removed) {
      statusEl.textContent = '✓ No re-encoded copies found'; statusEl.style.color = '#4ade80';
    } else {
      statusEl.textContent = `✓ Hid ${(r.removed || 0).toLocaleString()} re-encoded ${r.removed === 1 ? 'copy' : 'copies'} across ${(r.groups || 0).toLocaleString()} ${r.groups === 1 ? 'photo' : 'photos'}`;
      statusEl.style.color = '#4ade80';
      loadStats(); loadIndex(); // refresh library now that copies are hidden
    }
  } catch (err) {
    statusEl.textContent = 'Scan failed — ' + err.message; statusEl.style.color = '#f87171';
  } finally {
    btn.disabled = false; btn.textContent = 'Find re-encoded copies';
  }
}

async function startDupScan() {
  const btn = document.getElementById('dupScanBtn');
  const statusEl = document.getElementById('dupScanStatus');
  const progress = document.getElementById('dupProgress');
  const autoMode = document.querySelector('input[name="dupMode"]:checked')?.value !== 'manual';
  btn.disabled = true; btn.textContent = 'Scanning…';
  statusEl.textContent = 'Starting…'; statusEl.style.color = 'var(--text-muted)';
  progress.style.display = 'block';
  document.getElementById('dupGroupsCard').style.display = 'none';
  try {
    await fetch('/api/aurora/settings/duplicates/scan', { method: 'POST' });
    if (_dupPoll) clearInterval(_dupPoll);
    _dupPoll = setInterval(async () => {
      try {
        const s = await fetch('/api/aurora/settings/duplicates/status').then(r => r.json());
        const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
        document.getElementById('dupProgressBar').style.width = pct + '%';
        document.getElementById('dupProgressLabel').textContent =
          `${(s.done || 0).toLocaleString()} / ${(s.total || 0).toLocaleString()} files scanned`;
        if (!s.running) {
          clearInterval(_dupPoll); _dupPoll = null;
          btn.disabled = false; btn.textContent = 'Scan for duplicates';
          if (s.error) {
            statusEl.textContent = 'Error: ' + s.error; statusEl.style.color = '#f87171';
          } else if (!s.groups) {
            statusEl.textContent = '✓ No duplicates found'; statusEl.style.color = '#4ade80';
          } else if (autoMode) {
            // Auto: resolve everything now, no manual review needed
            statusEl.textContent = `Found ${s.groups} groups — resolving automatically…`; statusEl.style.color = 'var(--text-muted)';
            try {
              const r = await fetch('/api/aurora/settings/duplicates/resolve-all', { method: 'POST' }).then(r => r.json());
              statusEl.textContent = `✓ Done — hid ${(r.removed || 0).toLocaleString()} duplicates across ${(r.groups || 0).toLocaleString()} groups`;
              statusEl.style.color = '#4ade80';
              document.getElementById('dupProgressBar').style.width = '100%';
              loadIndex(); // refresh the library
            } catch (_) { statusEl.textContent = 'Scan done but auto-resolve failed'; statusEl.style.color = '#f87171'; }
          } else {
            // Manual: show review UI
            statusEl.textContent = `Found ${s.groups} duplicate group${s.groups === 1 ? '' : 's'} — review below`;
            statusEl.style.color = '#f59e0b';
            loadDupGroups();
          }
        }
      } catch (_) {}
    }, 1200);
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message; statusEl.style.color = '#f87171';
    btn.disabled = false; btn.textContent = 'Scan for duplicates';
  }
}

async function loadDupGroups() {
  const card = document.getElementById('dupGroupsCard');
  const el = document.getElementById('dupGroups');
  try {
    const groups = await fetch('/api/aurora/settings/duplicates').then(r => r.json());
    if (!groups.length) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    el.innerHTML = '';
    for (const g of groups) {
      const div = document.createElement('div');
      div.className = 'dup-group';
      const hdr = document.createElement('div');
      hdr.className = 'dup-group-hdr';
      hdr.innerHTML = `${g.count} identical copies <span style="font-family:var(--font-mono);font-size:10px;opacity:0.4">${g.hash.slice(0, 8)}…</span>`;
      div.appendChild(hdr);

      const thumbRow = document.createElement('div');
      thumbRow.className = 'dup-thumbs';
      for (const a of g.assets) {
        const item = document.createElement('div');
        item.className = 'dup-item';
        const img = document.createElement('img');
        img.className = 'dup-thumb';
        img.src = thumbUrl(a.id, 'grid');
        img.addEventListener('click', () => openLightboxById(a.id));
        const fname = document.createElement('div');
        fname.className = 'dup-fname';
        fname.textContent = a.path.split('/').pop();
        fname.title = a.path;
        const fsize = document.createElement('div');
        fsize.className = 'dup-fsize';
        fsize.textContent = a.bytes ? fmtBytes(a.bytes) : '—';
        const keepBtn = document.createElement('button');
        keepBtn.className = 'dup-keep-btn';
        keepBtn.textContent = 'Keep this';
        keepBtn.addEventListener('click', () => resolveDup(g.assets.map(x => x.id), a.id, div));
        item.appendChild(img); item.appendChild(fname); item.appendChild(fsize); item.appendChild(keepBtn);
        thumbRow.appendChild(item);
      }
      div.appendChild(thumbRow);

      const autoBtn = document.createElement('button');
      autoBtn.className = 'btn btn-ghost';
      autoBtn.style.cssText = 'font-size:12px;margin-top:10px;';
      autoBtn.textContent = 'Auto-keep (largest file)';
      autoBtn.addEventListener('click', () => {
        const best = g.assets.reduce((b, a) => (a.bytes || 0) > (b.bytes || 0) ? a : b, g.assets[0]);
        resolveDup(g.assets.map(x => x.id), best.id, div);
      });
      div.appendChild(autoBtn);
      el.appendChild(div);
    }
  } catch (_) { el.innerHTML = '<div style="color:#f87171;font-size:12px;">Failed to load duplicate groups</div>'; card.style.display = 'block'; }
}

async function resolveDup(allIds, keepId, groupEl) {
  const removeIds = allIds.filter(id => id !== keepId);
  try {
    await fetch('/api/aurora/settings/duplicates/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepId, removeIds })
    });
    groupEl.style.transition = 'opacity 0.3s';
    groupEl.style.opacity = '0.4';
    groupEl.innerHTML = `<div style="color:#4ade80;font-size:12px;padding:8px;">✓ Resolved — ${removeIds.length} duplicate${removeIds.length === 1 ? '' : 's'} hidden from library</div>`;
    toast(`${removeIds.length} duplicate${removeIds.length === 1 ? '' : 's'} hidden`);
    loadIndex();
  } catch (_) { toast('Failed to resolve duplicates'); }
}

// Open a specific asset in the lightbox (used from dup groups)
function openLightboxById(id) {
  const idx = state.lightboxItems.findIndex(a => a.id === id);
  if (idx >= 0) openLightbox(idx);
}

// ── Debug perf HUD ──────────────────────────────────────────────────────
// Enable: open the app with ?debug=1 (persists). Disable: ?debug=0.
// Shows live FPS, DOM tile/video counts, running CSS animations, JS heap,
// long-task blocking time, and how many Live previews have been spawned —
// enough to pinpoint what's burning the GPU/CPU on the actual device.
(function () {
  try {
    const p = new URLSearchParams(location.search).get('debug');
    if (p === '1') localStorage.setItem('aurora_debug', '1');
    if (p === '0') localStorage.removeItem('aurora_debug');
    if (localStorage.getItem('aurora_debug') !== '1') return;
  } catch (_) { return; }

  const hud = document.getElementById('perfHud');
  hud.style.display = 'block';

  // FPS via rAF
  let frames = 0, last = performance.now(), fps = 0, minFps = 999;
  (function loop(now) {
    frames++;
    if (now - last >= 500) {
      fps = Math.round((frames * 1000) / (now - last));
      if (fps < minFps) minFps = fps;
      frames = 0; last = now;
    }
    requestAnimationFrame(loop);
  })(performance.now());

  // Long tasks (main-thread blocking)
  let longTasks = 0, blockingMs = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longTasks++; blockingMs += Math.max(0, e.duration - 50); }
    }).observe({ entryTypes: ['longtask'] });
  } catch (_) {}

  // Reset min-fps / long-task counters by tapping the HUD area is awkward
  // (pointer-events:none), so just expose a console helper.
  window.__resetPerf = () => { minFps = 999; longTasks = 0; blockingMs = 0; window.__auroraPerf.previewsCreated = 0; };

  const activeScreen = () => {
    const s = document.querySelector('.screen.active');
    return s ? s.id.replace('screen-', '') : '—';
  };
  const cls = (v, warn, bad) => v >= bad ? 'bad' : v >= warn ? 'warn' : '';

  setInterval(() => {
    const tiles = document.querySelectorAll('.photo-tile').length;
    const vids = document.querySelectorAll('video').length;
    const previews = document.querySelectorAll('video.tile-live-preview').length;
    let anims = '—'; try { if (document.getAnimations) anims = document.getAnimations().length; } catch (_) {}
    const heap = (performance.memory) ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'M' : 'n/a';
    const pf = window.__auroraPerf;
    hud.innerHTML =
      `<b>${pf.build}</b>\n` +
      `screen   ${activeScreen()}\n` +
      `fps      <span class="${fps < 30 ? 'bad' : fps < 50 ? 'warn' : ''}">${fps}</span>  (min ${minFps === 999 ? '—' : minFps})\n` +
      `tiles    ${tiles}\n` +
      `videos   <span class="${cls(vids, 1, 4)}">${vids}</span>  (preview ${previews})\n` +
      `previews spawned: <span class="${cls(pf.previewsCreated, 1, 5)}">${pf.previewsCreated}</span>\n` +
      `ptrType  ${pf.lastPointerType}\n` +
      `anims    <span class="${typeof anims === 'number' ? cls(anims, 40, 120) : ''}">${anims}</span>\n` +
      `heap     ${heap}\n` +
      `longtask ${longTasks}  block ${Math.round(blockingMs)}ms`;
  }, 500);
})();

// ── PWA: register service worker so Aurora installs as a home-screen app ──
if ('serviceWorker' in navigator) {
  // When a new SW takes control after a deploy, reload once so the user lands
  // on the fresh build automatically (no more stale-cache surprises).
  let _swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swReloaded) return; _swReloaded = true; location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/aurora-sw.js', { scope: '/aurora' }).catch(() => {});
  });
}

// ── RBAC / auth (client side) ──────────────────────────────────────
// Fetched once on boot. Server enforces every permission; this state only
// decides what to show in the UI.
window.AURORA_ME = null;
function havePerm(key) {
  return !!(window.AURORA_ME && window.AURORA_ME.permissions && window.AURORA_ME.permissions.indexOf(key) >= 0);
}
async function loadMe() {
  try {
    const r = await fetch('/api/aurora/auth/me');
    if (!r.ok) return;
    window.AURORA_ME = await r.json();
    applyTheme(window.AURORA_ME.theme || 'purple');
    applyPermissionsToUI();
    renderUserChip();
    // If the account is flagged (admin reset, or admin created a fresh
    // user), the app is unusable until the user picks their own PIN.
    if (window.AURORA_ME.mustChangePin) openChangePinDialog({ forced: true });
  } catch (_) {}
  finally {
    // Always drop the pre-load cloak, even if /me failed — otherwise nothing
    // with data-perm* would ever become visible.
    document.body.classList.add('perms-ready');
  }
}
// ── Change PIN dialog ──
// Reuses the RBAC dialog surface so styling matches the admin flows. When
// opened via {forced: true} the cancel button is hidden and clicks outside
// don't dismiss — the user must complete the change to continue.
function openChangePinDialog(opts) {
  const forced = !!(opts && opts.forced);
  const menu = document.getElementById('userMenu');
  if (menu) menu.classList.remove('show');
  const overlay = document.getElementById('rbacOverlay');
  overlay.style.display = 'flex';
  overlay.dataset.forced = forced ? '1' : '';
  const dlg = document.getElementById('rbacDialog');
  dlg.innerHTML = `
    <h3>${forced ? 'Choose a new PIN' : 'Change PIN'}</h3>
    ${forced ? '<div class="rbac-hint" style="margin-top:0;margin-bottom:8px;">An administrator reset your PIN. Pick a new 4-digit PIN before you continue.</div>' : ''}
    <label class="field">${forced ? 'Temporary PIN (from your admin)' : 'Current PIN'}</label>
    <input type="password" id="cp_old" maxlength="4" inputmode="numeric" pattern="\\d{4}" autocomplete="current-password" style="letter-spacing:12px;text-align:center;font-family:var(--font-mono);">
    <label class="field">New 4-digit PIN</label>
    <input type="password" id="cp_new" maxlength="4" inputmode="numeric" pattern="\\d{4}" autocomplete="new-password" style="letter-spacing:12px;text-align:center;font-family:var(--font-mono);">
    <label class="field">Confirm new PIN</label>
    <input type="password" id="cp_new2" maxlength="4" inputmode="numeric" pattern="\\d{4}" autocomplete="new-password" style="letter-spacing:12px;text-align:center;font-family:var(--font-mono);">
    <div class="err" id="rd_err"></div>
    <div class="actions">
      ${forced ? '' : '<button class="btn btn-ghost" onclick="closeRbacDialog()">Cancel</button>'}
      <button class="btn" id="cp_submit" onclick="submitChangePin()">${forced ? 'Set new PIN' : 'Update PIN'}</button>
    </div>
  `;
  ['cp_old','cp_new','cp_new2'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, '').slice(0, 4); });
  });
  setTimeout(() => document.getElementById('cp_old').focus(), 30);
}
async function submitChangePin() {
  const oldPin = document.getElementById('cp_old').value;
  const newPin = document.getElementById('cp_new').value;
  const newPin2 = document.getElementById('cp_new2').value;
  if (!/^\d{4}$/.test(newPin)) return showRbacErr('New PIN must be 4 digits');
  if (newPin !== newPin2) return showRbacErr('New PINs do not match');
  if (newPin === oldPin) return showRbacErr('New PIN must be different from the current PIN');
  const btn = document.getElementById('cp_submit');
  btn.disabled = true;
  try {
    const r = await fetch('/api/aurora/auth/change-pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPin: oldPin, newPin }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { showRbacErr(b.error || 'Failed'); btn.disabled = false; return; }
    if (window.AURORA_ME) window.AURORA_ME.mustChangePin = false;
    document.getElementById('rbacOverlay').dataset.forced = '';
    closeRbacDialog();
    toast('PIN updated — other devices signed out');
  } catch (e) {
    showRbacErr(e.message || 'Failed');
    btn.disabled = false;
  }
}
function applyPermissionsToUI() {
  const isAdmin = havePerm('users.manage');
  document.querySelectorAll('.admin-only').forEach(el => { el.style.display = isAdmin ? '' : 'none'; });
  // Elements can opt-in with data-perm="photos.hidden" (single) or
  // data-perm-any="settings.view users.manage" (any-of).
  document.querySelectorAll('[data-perm]').forEach(el => {
    el.style.display = havePerm(el.dataset.perm) ? '' : 'none';
  });
  document.querySelectorAll('[data-perm-any]').forEach(el => {
    const perms = String(el.dataset.permAny || '').split(/\s+/).filter(Boolean);
    el.style.display = perms.some(havePerm) ? '' : 'none';
  });
}
// Any 401 from the API means the session expired — bounce to /login. Wrap
// fetch once so we don't have to touch every call site.
(function wrapFetchFor401() {
  const orig = window.fetch;
  window.fetch = function (input, init) {
    return orig(input, init).then(res => {
      if (res.status === 401 && String((input && input.url) || input || '').indexOf('/api/aurora/') >= 0
          && location.pathname === '/aurora') {
        location.replace('/login?next=' + encodeURIComponent(location.pathname));
      }
      return res;
    });
  };
})();

// A user's chosen glyph, or the default person icon.
function avatarGlyph(a) { return (a && String(a).trim()) || '👤'; }
// Preset icons offered in the avatar picker (users & roles + self menu).
const AVATAR_CHOICES = ['👤','😀','😎','🦊','🐱','🐶','🐼','🦉','🌸','🌟','🔥','🌊','🏔','📷','🎸','⚽','🚀','👑','🦄','🍀','🎨','☕'];
function renderUserChip() {
  const me = window.AURORA_ME;
  if (!me) return;
  const glyph = avatarGlyph(me.avatar);
  // Insert the chip into the topbar of whichever screen is showing one, or
  // refresh the icon on chips that already exist (avatar can change at runtime).
  document.querySelectorAll('.topbar').forEach(bar => {
    let chip = bar.querySelector('.user-chip');
    if (!chip) {
      chip = document.createElement('button');
      chip.className = 'user-chip';
      chip.onclick = toggleUserMenu;
      bar.appendChild(chip);
    }
    chip.title = 'Signed in as ' + me.username + ' (' + me.role + ')';
    chip.innerHTML = '<span class="user-chip-av">' + escapeHtml(glyph) + '</span><span>' + escapeHtml(me.username) + '</span>';
  });
  const menu = document.getElementById('userMenu');
  const themeRow = (t, label) =>
    '<div class="row theme-row' + ((me.theme || 'purple') === t ? ' active' : '') + '" onclick="setMyTheme(\'' + t + '\')">' +
      '<span class="theme-swatch theme-swatch-' + t + '"></span>' + label +
    '</div>';
  menu.innerHTML =
    '<div class="row head">' + escapeHtml(glyph) + ' ' + escapeHtml(me.username) + ' · ' + escapeHtml(me.role) + '</div>' +
    '<div class="row sub-head">Theme</div>' +
    themeRow('purple', 'Aurora (purple)') +
    themeRow('dark', 'Dark') +
    themeRow('light', 'Light') +
    '<div class="row sep" onclick="openMyAvatarDialog()">Choose icon…</div>' +
    '<div class="row" onclick="openChangePinDialog()">Change PIN</div>' +
    '<div class="row" onclick="doLogout()">Sign out</div>';
}
function toggleUserMenu(e) {
  const menu = document.getElementById('userMenu');
  menu.classList.toggle('show');
  e && e.stopPropagation();
}
document.addEventListener('click', function () {
  const m = document.getElementById('userMenu'); if (m) m.classList.remove('show');
});
async function doLogout() {
  try { await fetch('/api/aurora/auth/logout', { method: 'POST' }); } catch (_) {}
  location.replace('/login');
}

// ── Theme (per-account) ────────────────────────────────────────────
// 'purple' is the default Aurora look; 'dark' is a neutral dark; 'light' is
// a light variant. Applied via data-theme on <html>; persisted per account
// (server) and mirrored to localStorage so it applies instantly on next boot
// with no flash before /me returns.
const THEMES = ['purple', 'dark', 'light'];
function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'purple';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('aurora.theme', t); } catch (_) {}
}
async function setMyTheme(theme) {
  if (!THEMES.includes(theme)) return;
  applyTheme(theme);
  if (window.AURORA_ME) window.AURORA_ME.theme = theme;
  renderUserChip();
  document.getElementById('userMenu').classList.add('show'); // keep menu open to show the tick
  try {
    await fetch('/api/aurora/auth/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch (_) {}
}

// Self-service avatar picker (from the account menu).
function openMyAvatarDialog() {
  document.getElementById('userMenu').classList.remove('show');
  const me = window.AURORA_ME || {};
  const cur = me.avatar || '';
  const swatches = AVATAR_CHOICES.map(g =>
    `<button class="av-choice${g === cur ? ' active' : ''}" onclick="pickMyAvatar('${g}')">${g}</button>`).join('');
  openRbacDialog(`
    <h3>Choose your icon</h3>
    <div class="av-grid">${swatches}</div>
    <div class="rbac-hint">Shown next to your name across Aurora.</div>
    <div class="actions"><button class="btn btn-ghost" onclick="closeRbacDialog()">Close</button></div>
  `);
}
async function pickMyAvatar(glyph) {
  const avatar = glyph === '👤' ? '' : glyph;   // person glyph = clear/default
  if (window.AURORA_ME) window.AURORA_ME.avatar = avatar;
  renderUserChip();
  closeRbacDialog();
  try {
    await fetch('/api/aurora/auth/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar })
    });
  } catch (_) {}
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ── Users tab ──────────────────────────────────────────────────────
async function loadUsers() {
  const r = await fetch('/api/aurora/auth/admin/users');
  if (!r.ok) return;
  const { users } = await r.json();
  const tbody = document.querySelector('#usersTable tbody');
  const rolesRes = await fetch('/api/aurora/auth/admin/roles');
  const { roles } = rolesRes.ok ? await rolesRes.json() : { roles: [] };
  window._usersCache = users;
  tbody.innerHTML = users.map(u => {
    const roleOptions = roles.map(r => `<option value="${escapeHtml(r.name)}"${r.name===u.role_name?' selected':''}>${escapeHtml(r.name)}</option>`).join('');
    const badge = u.role_name === 'admin' ? 'admin' : u.role_name === 'user' ? 'user' : 'custom';
    const last = u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : '—';
    return `<tr>
      <td><span class="user-av">${escapeHtml(avatarGlyph(u.avatar))}</span> ${escapeHtml(u.username)}</td>
      <td><select onchange="setUserRole(${u.id}, this.value)">${roleOptions}</select> <span class="rbac-badge ${badge}">${escapeHtml(u.role_name)}</span></td>
      <td>${u.disabled ? '<span class="rbac-badge disabled">disabled</span>' : '<span class="muted">active</span>'}</td>
      <td class="muted">${last}</td>
      <td><div class="rbac-row-actions">
        <button class="btn btn-ghost" onclick="openUserEditDialog(${u.id})">Edit</button>
        <button class="btn btn-ghost" onclick="resetUserPin(${u.id}, '${escapeHtml(u.username)}')">Reset PIN</button>
        <button class="btn btn-ghost" onclick="toggleUserDisabled(${u.id}, ${u.disabled ? 0 : 1})">${u.disabled ? 'Enable' : 'Disable'}</button>
        <button class="btn btn-ghost" onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')" style="color:#f87171;">Delete</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">No users yet.</td></tr>';
}
async function setUserRole(id, role) {
  const r = await fetch('/api/aurora/auth/admin/users/' + id + '/role', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); toast(b.error || 'Failed'); }
  loadUsers();
}
async function toggleUserDisabled(id, disabled) {
  const r = await fetch('/api/aurora/auth/admin/users/' + id + '/disabled', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: !!disabled }),
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); toast(b.error || 'Failed'); }
  loadUsers();
}
async function deleteUser(id, name) {
  if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
  const r = await fetch('/api/aurora/auth/admin/users/' + id, { method: 'DELETE' });
  if (!r.ok) { const b = await r.json().catch(() => ({})); toast(b.error || 'Failed'); return; }
  loadUsers();
}
function resetUserPin(id, name) {
  openRbacDialog(`
    <h3>Reset PIN for ${escapeHtml(name)}</h3>
    <label class="field">New 4-digit PIN</label>
    <input type="password" id="rd_pin" maxlength="4" inputmode="numeric" pattern="\\d{4}" autocomplete="new-password" style="letter-spacing:12px;text-align:center;font-family:var(--font-mono);">
    <div class="rbac-hint">User will be prompted to choose their own PIN on next sign in.</div>
    <div class="err" id="rd_err"></div>
    <div class="actions">
      <button class="btn btn-ghost" onclick="closeRbacDialog()">Cancel</button>
      <button class="btn" onclick="submitResetPin(${id})">Reset</button>
    </div>
  `);
  setTimeout(() => document.getElementById('rd_pin').focus(), 30);
}
async function submitResetPin(id) {
  const pin = document.getElementById('rd_pin').value;
  const r = await fetch('/api/aurora/auth/admin/users/' + id + '/pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) return showRbacErr(b.error || 'Failed');
  closeRbacDialog();
  toast('PIN reset — other sessions signed out');
  loadUsers();
}
function openUserAddDialog() {
  // Roles come from the admin/roles call — fetch fresh so a just-created role appears.
  fetch('/api/aurora/auth/admin/roles').then(r => r.json()).then(({ roles }) => {
    const roleOpts = (roles || []).map(r => `<option value="${escapeHtml(r.name)}"${r.name==='user'?' selected':''}>${escapeHtml(r.name)}</option>`).join('');
    openRbacDialog(`
      <h3>Add user</h3>
      <label class="field">Username</label>
      <input type="text" id="rd_user" autocomplete="off" spellcheck="false">
      <label class="field">4-digit PIN</label>
      <input type="password" id="rd_pin" maxlength="4" inputmode="numeric" pattern="\\d{4}" autocomplete="new-password" style="letter-spacing:12px;text-align:center;font-family:var(--font-mono);">
      <label class="field">Role</label>
      <select id="rd_role">${roleOpts}</select>
      <div class="rbac-hint">User will be prompted to choose their own PIN on first sign in.</div>
      <div class="err" id="rd_err"></div>
      <div class="actions">
        <button class="btn btn-ghost" onclick="closeRbacDialog()">Cancel</button>
        <button class="btn" onclick="submitAddUser()">Create user</button>
      </div>
    `);
    setTimeout(() => document.getElementById('rd_user').focus(), 30);
  });
}
async function submitAddUser() {
  const username = document.getElementById('rd_user').value.trim();
  const pin = document.getElementById('rd_pin').value;
  const role = document.getElementById('rd_role').value;
  const r = await fetch('/api/aurora/auth/admin/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin, role }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) return showRbacErr(b.error || 'Failed');
  closeRbacDialog();
  toast('User created');
  loadUsers();
}

// ── Admin: edit a user's name + icon ──
let _editUserAvatar = '';
function openUserEditDialog(id) {
  const u = (window._usersCache || []).find(x => x.id === id);
  if (!u) return;
  _editUserAvatar = u.avatar || '';
  const swatches = AVATAR_CHOICES.map(g =>
    `<button type="button" class="av-choice${(g === '👤' ? (_editUserAvatar === '') : (g === _editUserAvatar)) ? ' active' : ''}" data-glyph="${g}" onclick="selectEditAvatar(this)">${g}</button>`).join('');
  openRbacDialog(`
    <h3>Edit ${escapeHtml(u.username)}</h3>
    <label class="field">Username</label>
    <input type="text" id="ue_name" autocomplete="off" spellcheck="false" value="${escapeHtml(u.username)}">
    <label class="field">Icon</label>
    <div class="av-grid" id="ue_avgrid">${swatches}</div>
    <div class="err" id="rd_err"></div>
    <div class="actions">
      <button class="btn btn-ghost" onclick="closeRbacDialog()">Cancel</button>
      <button class="btn" onclick="submitUserProfile(${id})">Save</button>
    </div>
  `);
  setTimeout(() => { const el = document.getElementById('ue_name'); if (el) el.focus(); }, 30);
}
function selectEditAvatar(btn) {
  const g = btn.dataset.glyph;
  _editUserAvatar = g === '👤' ? '' : g;
  document.querySelectorAll('#ue_avgrid .av-choice').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
async function submitUserProfile(id) {
  const username = document.getElementById('ue_name').value.trim();
  const r = await fetch('/api/aurora/auth/admin/users/' + id + '/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, avatar: _editUserAvatar }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) return showRbacErr(b.error || 'Failed');
  closeRbacDialog();
  toast('User updated');
  loadUsers();
  // If the admin edited their own account, refresh the chip immediately.
  if (window.AURORA_ME && window.AURORA_ME.userId === id) {
    window.AURORA_ME.username = username;
    window.AURORA_ME.avatar = _editUserAvatar;
    renderUserChip();
  }
}

// ── Roles tab ──────────────────────────────────────────────────────
async function loadRoles() {
  const r = await fetch('/api/aurora/auth/admin/roles');
  if (!r.ok) return;
  const { roles, catalog } = await r.json();
  window._rbacCatalog = catalog;
  const tbody = document.querySelector('#rolesTable tbody');
  tbody.innerHTML = roles.map(r => {
    const badge = r.name === 'admin' ? 'admin' : r.name === 'user' ? 'user' : 'custom';
    const perms = r.name === 'admin' ? 'All permissions' :
      (r.permissions && r.permissions.length ? r.permissions.map(escapeHtml).join(', ') : '<span class="muted">None</span>');
    const editable = !(r.is_builtin && r.name === 'admin');
    return `<tr>
      <td><span class="rbac-badge ${badge}">${escapeHtml(r.name)}</span></td>
      <td class="muted">${r.is_builtin ? 'built-in' : 'custom'}</td>
      <td style="font-size:12px;">${perms}</td>
      <td><div class="rbac-row-actions">
        ${editable ? `<button class="btn btn-ghost" onclick="openRoleDialog(${r.id})">Edit</button>` : ''}
        ${!r.is_builtin ? `<button class="btn btn-ghost" onclick="deleteRole(${r.id}, '${escapeHtml(r.name)}')" style="color:#f87171;">Delete</button>` : ''}
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">No roles.</td></tr>';
}
async function deleteRole(id, name) {
  if (!confirm(`Delete role "${name}"?`)) return;
  const r = await fetch('/api/aurora/auth/admin/roles/' + id, { method: 'DELETE' });
  if (!r.ok) { const b = await r.json().catch(() => ({})); toast(b.error || 'Failed'); return; }
  loadRoles();
}
async function openRoleDialog(id) {
  // Load fresh so we always render against the latest catalog + current perms.
  const listRes = await fetch('/api/aurora/auth/admin/roles');
  const { roles, catalog } = await listRes.json();
  const existing = id ? roles.find(r => r.id === id) : null;
  const groups = {};
  catalog.forEach(p => { (groups[p.group] = groups[p.group] || []).push(p); });
  const permsHtml = Object.keys(groups).map(g => `
    <div class="rbac-perm-group">
      <h4>${escapeHtml(g)}</h4>
      <div class="rbac-perm-list">
        ${groups[g].map(p => {
          const checked = existing && existing.permissions.indexOf(p.key) >= 0 ? ' checked' : '';
          return `<label><input type="checkbox" data-perm="${escapeHtml(p.key)}"${checked}><span>${escapeHtml(p.label)} <span class="desc">(${escapeHtml(p.key)})</span></span></label>`;
        }).join('')}
      </div>
    </div>`).join('');
  openRbacDialog(`
    <h3>${existing ? 'Edit role: ' + escapeHtml(existing.name) : 'New role'}</h3>
    ${existing ? '' : '<label class="field">Name</label><input type="text" id="rd_name" autocomplete="off">'}
    ${permsHtml}
    <div class="err" id="rd_err"></div>
    <div class="actions">
      <button class="btn btn-ghost" onclick="closeRbacDialog()">Cancel</button>
      <button class="btn" onclick="submitRole(${existing ? existing.id : 'null'})">${existing ? 'Save' : 'Create role'}</button>
    </div>
  `);
}
async function submitRole(id) {
  const perms = [].slice.call(document.querySelectorAll('#rbacDialog input[data-perm]:checked')).map(el => el.dataset.perm);
  const body = { permissions: perms };
  if (!id) {
    const nameEl = document.getElementById('rd_name');
    body.name = nameEl ? nameEl.value.trim() : '';
  }
  const url = id ? '/api/aurora/auth/admin/roles/' + id : '/api/aurora/auth/admin/roles';
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) return showRbacErr(b.error || 'Failed');
  closeRbacDialog();
  loadRoles();
  loadUsers();
}

// ── Audit log tab ──────────────────────────────────────────────────
// 'admin' groups the user.* and role.* families; everything else filters by
// the action prefix, done server-side via the ?category= param.
let auditCategory = '';
function setAuditFilter(btn) {
  document.querySelectorAll('#auditFilterBar .audit-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  auditCategory = btn.dataset.cat || '';
  loadAudit();
}
// Friendly labels for the action codes so the log reads in plain English.
const AUDIT_LABELS = {
  'auth.login': 'Signed in', 'auth.login.fail': 'Failed sign-in', 'auth.logout': 'Signed out',
  'auth.setup': 'Claimed admin', 'auth.pin.change': 'Changed PIN',
  'photo.favorite': 'Favorited', 'photo.unfavorite': 'Un-favorited',
  'photo.tag.add': 'Added tag', 'photo.tag.remove': 'Removed tag',
  'photo.hide': 'Hid photo', 'photo.unhide': 'Un-hid photo',
  'photo.remove': 'Removed from library', 'photo.restore': 'Restored to library',
  'photo.download': 'Downloaded original',
  'album.create': 'Created album', 'album.delete': 'Deleted album',
  'import.start': 'Started import', 'import.reindex': 'Re-indexed metadata',
  'user.create': 'Created user', 'user.delete': 'Deleted user', 'user.role': 'Changed role',
  'user.disabled': 'Enabled/disabled user', 'user.pin.reset': 'Reset PIN', 'user.profile': 'Edited profile',
  'role.create': 'Created role', 'role.update': 'Updated role', 'role.delete': 'Deleted role',
};
function auditLabel(action) { return AUDIT_LABELS[action] || action; }
async function loadAudit() {
  const qs = '?limit=400' + (auditCategory === 'admin' ? '' : (auditCategory ? '&category=' + encodeURIComponent(auditCategory) : ''));
  const r = await fetch('/api/aurora/auth/admin/audit' + qs);
  if (!r.ok) return;
  let { entries } = await r.json();
  // 'admin' spans two action families (user.* + role.*) — filter client-side.
  if (auditCategory === 'admin') entries = entries.filter(e => /^(user|role)\./.test(e.action));
  const tbody = document.querySelector('#auditTable tbody');
  tbody.innerHTML = entries.map(e => `
    <tr>
      <td class="muted" style="white-space:nowrap;">${new Date(e.ts).toLocaleString()}</td>
      <td>${escapeHtml(e.username || '—')}</td>
      <td title="${escapeHtml(e.action)}">${escapeHtml(auditLabel(e.action))}</td>
      <td class="muted">${escapeHtml(e.target || '')}</td>
      <td class="muted" style="font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.details || '')}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No entries in this category.</td></tr>';
}

// ── RBAC dialog helpers ────────────────────────────────────────────
function openRbacDialog(html) {
  const ov = document.getElementById('rbacOverlay');
  ov.dataset.forced = '';   // regular dialog — allow dismissal
  document.getElementById('rbacDialog').innerHTML = html;
  ov.style.display = 'flex';
}
function closeRbacDialog() {
  const ov = document.getElementById('rbacOverlay');
  if (ov.dataset.forced) return;   // change-PIN can't be dismissed
  ov.style.display = 'none';
  document.getElementById('rbacDialog').innerHTML = '';
}
function showRbacErr(msg) {
  const el = document.getElementById('rd_err');
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

// ── Sidebar collapse (desktop only) ──
// Persisted so it survives reloads. Mobile ignores this — bottom-nav owns
// navigation there and the sidebar itself is display:none.
function applySidebarState() {
  try {
    const v = localStorage.getItem('aurora.sidebarCollapsed');
    document.body.classList.toggle('sidebar-collapsed', v === '1');
  } catch (_) {}
}
function toggleSidebar() {
  const now = !document.body.classList.contains('sidebar-collapsed');
  document.body.classList.toggle('sidebar-collapsed', now);
  try { localStorage.setItem('aurora.sidebarCollapsed', now ? '1' : '0'); } catch (_) {}
  // The library grid is virtualized on width — re-layout after the CSS
  // transition finishes so tiles snap to the new column count.
  setTimeout(() => {
    try { if (typeof computeGridLayout === 'function') { computeGridLayout(); paintWindow(true); } } catch (_) {}
    try { if (svgrid && svgrid.items.length) { searchComputeLayout(); searchPaintWindow(); } } catch (_) {}
  }, 220);
}
applySidebarState();

// ── Boot ──
(async () => {
  await loadMe();
  await loadStats();
  await loadIndex();
  // Web fonts can change the toolbar's height after first paint — remeasure
  // the overlay inset once they've settled so the gallery's top offset is exact.
  try { await document.fonts.ready; } catch (_) {}
  updateLibInset();
})();
