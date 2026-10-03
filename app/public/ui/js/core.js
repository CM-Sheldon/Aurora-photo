/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — core.js
   Shared state, formatting helpers, the fetch/permission layer, theme, and
   screen navigation. Every other /ui/js file builds on these globals; this
   file must load first (see the JS list in views/aurora.ejs).
   ════════════════════════════════════════════════════════════════════════ */

// ── Build identity + stale-build detector ──────────────────────────────────
// PAGE_BUILD is baked into the HTML at render time (version.json). If the live
// server reports a different build, the page is a stale cached copy: offer a
// reload. Polled every 60s and on resume so an open PWA notices in-app updates.
const PAGE_VERSION = (window.AURORA_BOOT && window.AURORA_BOOT.version) || 'dev';
const PAGE_BUILD = (window.AURORA_BOOT && window.AURORA_BOOT.build) || 'dev';
const CACHE_EPOCH = (window.AURORA_BOOT && window.AURORA_BOOT.cacheEpoch) || '0';
const AURORA_BUILD = PAGE_VERSION + ' · ' + PAGE_BUILD;
window.__auroraPerf = { build: AURORA_BUILD, previewsCreated: 0, lastPointerType: '—' };
console.log('[Aurora] page build', AURORA_BUILD);

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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkServerBuild(); });
function showUpdateBanner(srv) {
  if (document.getElementById('updateBanner')) return;
  const b = document.createElement('div');
  b.id = 'updateBanner';
  b.innerHTML = `<span>New version available (${escapeHtml(srv.version)})</span><button type="button" onclick="hardReload()">Reload</button>`;
  document.body.appendChild(b);
}
// Drops every cache + service worker BEFORE reloading, so the fresh build loads.
async function hardReload() {
  try {
    if ('caches' in window) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); }
    if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); }
  } catch (_) {}
  location.reload();
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  assets: [],            // full lightweight library index (id, taken_at, kind, fav, live_video_id, duration_s)
  filtered: [],          // index after the Library view filters
  timeMin: 0, timeMax: 0,
  monthBase: 0, totalMonths: 1,   // month domain shared by every date-range control
  kindFilter: 'all',     // Library: all | photo | video | fav
  libFrom: 0, libTo: 0,  // Library date filter (month indices)
  lightboxIdx: -1,
  lightboxItems: [],
  lightboxGrid: null,    // VirtualGrid the viewer was opened from (for the zoom-back)
  metaAssetId: null,
  selectMode: false,
  selected: new Set(),
  selectList: [],        // items in the grid that select mode operates on
  selectGrid: null,
  hideRaw: (() => { try { return localStorage.getItem('aurora_hideRaw') === '1'; } catch (_) { return false; } })(),
  privateUnlocked: false,
  assetsLoaded: false,
  screen: 'library',
  lastTab: 'library',
};

// ── Small helpers ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
const canHover = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
function debounce(fn, ms) { let t = null; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Icon markup: ic('heart') → <svg class="i"><use href="#i-heart"/></svg>
function ic(name, cls) { return `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`; }
function plural(n, one, many) { return `${(n || 0).toLocaleString()} ${n === 1 ? one : (many || one + 's')}`; }

function fmtBytes(b) {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i ? v.toFixed(1) : v) + ' ' + u[i];
}
function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function fmtDateLong(ms) { return ms ? new Date(ms).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'Unknown date'; }
function fmtTime(ms) { return ms ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''; }
function fmtDateTime(ms) { return ms ? fmtDate(ms) + ', ' + fmtTime(ms) : '—'; }
function fmtYear(ms) { return ms ? new Date(ms).getFullYear() : null; }
function fmtMon(ms) { return ms ? new Date(ms).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'Unknown date'; }
function fmtMonShort(ms) { return ms ? new Date(ms).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '—'; }
function fmtDuration(s) {
  if (!s && s !== 0) return null;
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtRelative(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
  return fmtDate(ts);
}
// Month-precision helpers shared by every date-range control (local time).
function startOfMonth(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
function addMonths(ms, n) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); }
function monthIndexOf(ms) { const b = new Date(state.monthBase || ms), d = new Date(ms); return (d.getFullYear() - b.getFullYear()) * 12 + (d.getMonth() - b.getMonth()); }
function monthRangeLabel(fromIdx, toIdx) {
  const from = addMonths(state.monthBase, fromIdx), to = addMonths(state.monthBase, toIdx);
  return fromIdx === toIdx ? fmtMonShort(from) : fmtMonShort(from) + ' – ' + fmtMonShort(to);
}

// Thumbnails: the cache epoch (latest import) busts stale browser copies after a
// re-import reassigns ids. Sizes: grid 280² crop · cover 400² · preview 800² · full 2048.
function thumbUrl(id, size = 'grid') { return `/api/aurora/thumb/${id}?size=${size}&v=${CACHE_EPOCH}`; }
// <img> for a cover/preview: shows the (usually cached) grid thumb instantly, then
// swaps in the sharper size once it has loaded. Falls back to grid on error.
// One shared observer for every progressive image (hundreds of month cards).
let _hiResIO = null;
function hiResObserver() {
  if (!_hiResIO && 'IntersectionObserver' in window) {
    _hiResIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        _hiResIO.unobserve(e.target);
        const go = e.target._hiResGo;
        e.target._hiResGo = null;
        if (go) go();
      }
    }, { rootMargin: '300px' });
  }
  return _hiResIO;
}
function progressiveImg(id, size, alt) {
  const img = document.createElement('img');
  img.alt = alt || ''; img.decoding = 'async'; img.loading = 'lazy';
  img.src = thumbUrl(id, 'grid');
  if (size && size !== 'grid') {
    // Defer the big fetch until the card is near the viewport.
    const go = () => {
      const hi = new Image();
      hi.decoding = 'async';
      hi.onload = () => { img.src = hi.src; };
      hi.src = thumbUrl(id, size);
    };
    const io = hiResObserver();
    if (io) { img._hiResGo = go; io.observe(img); } else go();
  }
  return img;
}

// Cover / preview thumbnails are made on demand from the original; if that
// fails (file offline, unreadable), fall back to the always-present grid thumb.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || img.dataset.fb) return;
  if (/[?&]size=(cover|preview|full)\b/.test(img.src)) {
    img.dataset.fb = '1';
    img.src = img.src.replace(/size=(cover|preview|full)\b/, 'size=grid');
  }
}, true);

// ── JSON fetch helpers ─────────────────────────────────────────────────────
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
}
async function postJSON(url, data, opts) {
  return getJSON(url, Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }, opts || {}));
}
// Any 401 from the API means the session expired — bounce to the sign-in page.
(function wrapFetchFor401() {
  const orig = window.fetch;
  window.fetch = function (input, init) {
    return orig(input, init).then(res => {
      if (res.status === 401 && String((input && input.url) || input || '').indexOf('/api/aurora/') >= 0 && location.pathname === '/aurora') {
        location.replace('/login?next=' + encodeURIComponent(location.pathname));
      }
      return res;
    });
  };
})();

// ── Toast + button feedback ────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, dur = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), dur);
}
// Instant "working…" feedback on a button; returns done(label?) to restore it.
function btnBusy(btn, busyLabel) {
  if (!btn) return () => {};
  if (btn.dataset.busy === '1') return () => {};
  const orig = btn.dataset.origHtml || btn.innerHTML;
  btn.dataset.origHtml = orig;
  btn.dataset.busy = '1';
  btn.disabled = true;
  const label = btn.querySelector('.row-label');
  if (label) { label.dataset.orig = label.dataset.orig || label.textContent; label.innerHTML = `<span class="spin-dot"></span> ${escapeHtml(busyLabel || 'Working…')}`; }
  else btn.innerHTML = `<span class="spin-dot"></span>${escapeHtml(busyLabel || 'Working…')}`;
  return (doneLabel) => {
    btn.dataset.busy = '0';
    btn.disabled = false;
    const restore = () => { if (btn.dataset.busy === '1') return; if (label) label.textContent = label.dataset.orig; else btn.innerHTML = orig; };
    if (doneLabel) {
      if (label) label.textContent = doneLabel; else btn.textContent = doneLabel;
      setTimeout(restore, 1800);
    } else restore();
  };
}
function setStatus(el, msg, kind) {
  if (typeof el === 'string') el = $(el);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('err', kind === 'err');
}
function setActionStatus(msg, kind) { setStatus('settingsActionStatus', msg, kind); }

// ── Permissions ────────────────────────────────────────────────────────────
// Fetched once on boot (admin.js → loadMe). The server enforces every permission;
// this only decides what to show.
window.AURORA_ME = null;
function havePerm(key) {
  return !!(window.AURORA_ME && window.AURORA_ME.permissions && window.AURORA_ME.permissions.indexOf(key) >= 0);
}
function applyPermissionsToUI(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-perm]').forEach(el => { el.style.display = havePerm(el.dataset.perm) ? '' : 'none'; });
  scope.querySelectorAll('[data-perm-any]').forEach(el => {
    const perms = String(el.dataset.permAny || '').split(/\s+/).filter(Boolean);
    el.style.display = perms.some(havePerm) ? '' : 'none';
  });
  if (!root && typeof tidySettingsGroups === 'function') tidySettingsGroups();
}
// Can this role do anything in select mode?
function canSelect() { return ['photos.tag', 'photos.download', 'photos.hidden', 'photos.delete', 'photos.favorite', 'albums.manage'].some(havePerm); }

// ── Theme (per-account, mirrored to localStorage for a flash-free boot) ────
const THEMES = ['purple', 'dark', 'light'];
function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'purple';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('aurora.theme', t); } catch (_) {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#ffffff' : '#000000');
  document.querySelectorAll('[data-theme-opt]').forEach(b => b.classList.toggle('on', b.dataset.themeOpt === t));
}

// ── Screen navigation ──────────────────────────────────────────────────────
// Tabs: library · places · collections · search. Settings is a full screen
// reached from the avatar (or the desktop sidebar). 'albums' is the v1 name
// for Collections and is still accepted.
const TAB_SCREENS = ['library', 'places', 'collections', 'search'];
const screenHooks = {};   // id → { enter(), leave() } registered by each module
function registerScreen(id, hooks) { screenHooks[id] = hooks; }

function switchScreen(id, opts) {
  if (id === 'albums') id = 'collections';
  if (id === 'import') id = 'settings';
  const prev = state.screen;
  if (state.selectMode) exitSelectMode();
  if (typeof closeDetail === 'function' && id !== 'detail') closeDetail(true);
  if (typeof closePlaceSheet === 'function' && id !== 'places') closePlaceSheet();
  if (prev !== id && screenHooks[prev] && screenHooks[prev].leave) screenHooks[prev].leave();
  document.querySelectorAll('.main > .screen:not(.pushed)').forEach(s => s.classList.toggle('active', s.id === 'screen-' + id));
  const el = $('screen-' + id);
  if (el && prev !== id && !(opts && opts.noAnim)) { el.classList.remove('screen-in'); void el.offsetWidth; el.classList.add('screen-in'); }
  document.querySelectorAll('[data-screen]').forEach(n => n.classList.toggle('active', n.dataset.screen === id));
  state.screen = id;
  if (TAB_SCREENS.includes(id) && id !== 'search') state.lastTab = id;
  document.body.classList.toggle('no-tabbar', id === 'search' || id === 'settings');
  document.body.dataset.screen = id;
  setTabbarMin(false);
  if (screenHooks[id] && screenHooks[id].enter) screenHooks[id].enter(prev);
}
document.querySelectorAll('[data-screen]').forEach(item => {
  item.addEventListener('click', () => {
    const id = item.dataset.screen;
    // Tapping the active (minimised) tab restores the bar / scrolls to top.
    if (id === state.screen) {
      const tb = $('tabbar');
      if (tb && tb.classList.contains('min')) { setTabbarMin(false); return; }
      if (screenHooks[id] && screenHooks[id].reselect) screenHooks[id].reselect();
      return;
    }
    switchScreen(id);
  });
});

function setTabbarMin(min) {
  const tb = $('tabbar');
  if (tb) tb.classList.toggle('min', !!min);
}

// Hides a screen's floating chrome (title, buttons, zoom control) and shrinks
// the tab bar while scrolling down; brings it back after a deliberate scroll up.
class ScrollChrome {
  constructor(screenEl, scroller, opts = {}) {
    this.screen = screenEl; this.scroller = scroller;
    this.lastY = 0; this.up = 0; this.min = false;
    this.threshold = opts.threshold || 140;
    scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
  }
  onScroll() {
    const y = this.scroller.scrollTop, dy = y - this.lastY;
    this.lastY = y;
    if (state.selectMode) return;
    if (y < this.threshold) { this.up = 0; this.set(false); return; }
    if (dy > 6) { this.up = 0; this.set(true); }
    else if (dy < 0) { this.up -= dy; if (this.up > 220) { this.up = 0; this.set(false); } }
  }
  set(min) {
    if (this.min === min) return;
    this.min = min;
    this.screen.classList.toggle('chrome-min', min);
    setTabbarMin(min);
  }
  reset() { this.up = 0; this.lastY = this.scroller.scrollTop; this.set(false); }
}

// ── Desktop sidebar collapse (persisted) ───────────────────────────────────
function applySidebarState() {
  try { document.body.classList.toggle('sidebar-collapsed', localStorage.getItem('aurora.sidebarCollapsed') === '1'); } catch (_) {}
}
function toggleSidebar() {
  const now = !document.body.classList.contains('sidebar-collapsed');
  document.body.classList.toggle('sidebar-collapsed', now);
  try { localStorage.setItem('aurora.sidebarCollapsed', now ? '1' : '0'); } catch (_) {}
  setTimeout(() => window.dispatchEvent(new Event('resize')), 230);
}
applySidebarState();

// iOS: stop the page itself from pinch-zooming (the grid and viewer handle pinch).
document.addEventListener('gesturestart', (e) => e.preventDefault());
