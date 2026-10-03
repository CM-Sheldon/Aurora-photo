/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — library.js
   The Library screen: loads the lightweight index, applies the view filters
   (Photos / Videos / Favourites + date range), drives the edge-to-edge grid,
   the Years · Months · All zoom levels, the scrubber, and the live month
   subtitle under the title.
   ════════════════════════════════════════════════════════════════════════ */

const libScroll = $('libScroll');
let libView = 'all';                      // years | months | all
const libChrome = new ScrollChrome($('screen-library'), libScroll);

// The grid starts below the floating title and scrolls under it.
function libTopInset() { const h = $('libHeader'); return (h ? h.offsetHeight : 110) + 2; }
function libBottomInset() { return isPhone() ? 160 : 96; }

const libGrid = new VirtualGrid({
  el: $('photoGrid'), scroller: libScroll, name: 'library',
  padTop: libTopInset, padBottom: libBottomInset,
  onScroll: () => { updateLibSubtitle(); scrubberOnScroll(); },
});

// ── Stats (sidebar + Settings overview badge) ─────────────────────────────
async function loadStats() {
  try {
    const s = await getJSON('/api/aurora/stats');
    $('statPhotos').textContent = (s.photos || 0).toLocaleString();
    $('statVideos').textContent = (s.videos || 0).toLocaleString();
    $('statPlaces').textContent = (s.place_count || 0).toLocaleString();
    $('statStorage').textContent = fmtBytes(s.total_bytes);
    $('navBadgeLibrary').textContent = (s.total || 0).toLocaleString();
    const ov = $('sOverviewVal'); if (ov) ov.textContent = (s.total || 0).toLocaleString();
  } catch (_) {}
}

// ── Index ─────────────────────────────────────────────────────────────────
async function loadIndex() {
  try {
    const data = await getJSON('/api/aurora/assets/index' + (state.hideRaw ? '?hideRaw=1' : ''));
    // Compact wire fields → the names used across the UI.
    state.assets = data.map(r => ({ id: r.id, taken_at: r.t, kind: r.k, fav: r.f, live_video_id: r.lv, duration_s: r.d }));
  } catch (_) {
    state.assets = [];
  }
  state.assetsLoaded = true;
  // Never Math.min(...bigArray): spreading 100k+ items overflows the stack.
  let lo = Infinity, hi = -Infinity;
  for (const a of state.assets) {
    if (!a.taken_at) continue;
    if (a.taken_at < lo) lo = a.taken_at;
    if (a.taken_at > hi) hi = a.taken_at;
  }
  state.timeMin = lo === Infinity ? 0 : lo;
  state.timeMax = hi === -Infinity ? 0 : hi;
  const anchor = state.timeMin || Date.now();
  const prevTotal = state.totalMonths;
  state.monthBase = startOfMonth(anchor);
  state.totalMonths = Math.max(1, monthIndexOf(state.timeMax || anchor) + 1);
  // Keep an active date filter; reset it if the domain changed underneath it.
  if (!libDateActive() || prevTotal !== state.totalMonths) { state.libFrom = 0; state.libTo = state.totalMonths - 1; }
  applyFilters({ keepScroll: true });
}

function libDateActive() { return state.libFrom > 0 || state.libTo < state.totalMonths - 1; }

function applyFilters(opts = {}) {
  const dateOn = libDateActive();
  const from = addMonths(state.monthBase, state.libFrom);
  const to = addMonths(state.monthBase, state.libTo + 1) - 1;
  const k = state.kindFilter;
  state.filtered = state.assets.filter(a => {
    if (k === 'photo' && a.kind !== 'photo') return false;
    if (k === 'video' && a.kind !== 'video') return false;
    if (k === 'fav' && !a.fav) return false;
    // Undated items only show with no date filter (they'd swamp any narrow range).
    if (!a.taken_at) return !dateOn;
    if (dateOn && (a.taken_at < from || a.taken_at > to)) return false;
    return true;
  });
  renderLibFilterPills();
  $('libraryLoading').hidden = true;
  $('libraryEmpty').hidden = !(state.assetsLoaded && !state.filtered.length);
  if (state.selectMode && state.selectGrid === libGrid) exitSelectMode();
  libGrid.setItems(state.filtered, { keepScroll: !!opts.keepScroll });
  if (libView !== 'all') renderZoomView();
  updateLibSubtitle(true);
  scrubYearsCache = null;
}

// ── Subtitle: month of the topmost visible row · item count ───────────────
let _subKey = '';
function updateLibSubtitle(force) {
  const sub = $('libSubtitle');
  const n = state.filtered.length;
  let label = '';
  if (n && libView === 'all' && libGrid.cellW) {
    const idx = libGrid.indexAtContentY(libScroll.scrollTop + libGrid.padTop + libGrid.cellW * 0.4);
    const it = state.filtered[idx];
    label = it ? (it.taken_at ? fmtMon(it.taken_at) : 'Undated') : '';
  }
  const text = n ? (label ? `${label} · ${plural(n, 'item')}` : plural(n, 'item')) : (state.assetsLoaded ? 'No items' : ' ');
  if (force || text !== _subKey) { _subKey = text; sub.textContent = text; }
}

// ── Filters: view menu + pills ────────────────────────────────────────────
function setKindFilter(k) { state.kindFilter = k; applyFilters(); }
function openLibraryViewMenu(anchor) {
  const k = state.kindFilter;
  openMenu(anchor, [
    { label: 'All items', checked: k === 'all', onClick: () => setKindFilter('all') },
    { label: 'Photos', checked: k === 'photo', icon: 'photo', onClick: () => setKindFilter('photo') },
    { label: 'Videos', checked: k === 'video', icon: 'video', onClick: () => setKindFilter('video') },
    { label: 'Favourites', checked: k === 'fav', icon: 'heart', onClick: () => setKindFilter('fav') },
    { sep: true },
    { label: libDateActive() ? monthRangeLabel(state.libFrom, state.libTo) : 'Filter by date…', icon: 'cal', onClick: openLibraryRange },
    { label: 'Clear date filter', icon: 'x', hidden: !libDateActive(), onClick: () => { state.libFrom = 0; state.libTo = state.totalMonths - 1; applyFilters(); } },
    { sep: true },
    { label: 'Bigger tiles', icon: 'plus', disabled: GRID_ZOOM.level <= 0, onClick: () => setGridZoom(GRID_ZOOM.level - 1) },
    { label: 'Smaller tiles', icon: 'minus', disabled: GRID_ZOOM.level >= GRID_ZOOM.phoneCols.length - 1, onClick: () => setGridZoom(GRID_ZOOM.level + 1) },
  ], { title: 'Show' });
}
function openLibraryRange() {
  const apply = debounce(() => applyFilters(), 160);
  openRangeSheet({
    title: 'Filter by date', from: state.libFrom, to: state.libTo,
    onChange: (f, t) => { state.libFrom = f; state.libTo = t; apply(); },
  });
}
function renderLibFilterPills() {
  const row = $('libFilterRow');
  const pills = [];
  const kindLabel = { photo: 'Photos', video: 'Videos', fav: 'Favourites' }[state.kindFilter];
  if (kindLabel) pills.push(`<button type="button" class="pill" data-clear="kind">${escapeHtml(kindLabel)} ${ic('x', 'sm')}</button>`);
  if (libDateActive()) pills.push(`<button type="button" class="pill" data-clear="date">${ic('cal', 'sm')}${escapeHtml(monthRangeLabel(state.libFrom, state.libTo))} ${ic('x', 'sm')}</button>`);
  const had = !row.hidden;
  row.innerHTML = pills.join('');
  row.hidden = !pills.length;
  if (had !== !row.hidden) libGrid.dirty = true;   // header height changed → grid inset
}
$('libFilterRow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-clear]');
  if (!b) return;
  if (b.dataset.clear === 'kind') state.kindFilter = 'all';
  else { state.libFrom = 0; state.libTo = state.totalMonths - 1; }
  applyFilters();
});

// ── Years · Months · All ──────────────────────────────────────────────────
$('libZoomSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-zoomview]');
  if (b) setLibView(b.dataset.zoomview);
});
function setLibView(view, opts = {}) {
  if (view === libView && !opts.force) return;
  // Remember which month is on screen so the next level opens there.
  const topItem = libView === 'all' && libGrid.cellW
    ? state.filtered[libGrid.indexAtContentY(libScroll.scrollTop + libGrid.padTop + 4)] : null;
  libView = view;
  document.querySelectorAll('#libZoomSeg [data-zoomview]').forEach(b => b.classList.toggle('on', b.dataset.zoomview === view));
  $('photoGrid').hidden = view !== 'all';
  $('libYears').hidden = view !== 'years';
  $('libMonths').hidden = view !== 'months';
  $('libScrubber').classList.remove('show');
  libChrome.reset();
  if (view === 'all') {
    libGrid.relayout();
    if (opts.scrollToIdx != null) libGrid.scrollToIndex(opts.scrollToIdx);
    updateLibSubtitle(true);
    return;
  }
  renderZoomView();
  const ms = opts.scrollToMs || (topItem && topItem.taken_at) || null;
  const host = $(view === 'years' ? 'libYears' : 'libMonths');
  let target = null;
  if (ms) {
    const key = view === 'years' ? String(new Date(ms).getFullYear()) : monthKeyOf(ms);
    target = host.querySelector(`[data-key="${key}"]`);
  }
  libScroll.scrollTop = target ? Math.max(0, target.offsetTop - libTopInset() - 8) : 0;
  $('libSubtitle').textContent = plural(state.filtered.length, 'item');
}
function monthKeyOf(ms) { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

// Groups consecutive (date-desc) items by year or month, with a cover photo:
// a favourite if there is one, otherwise the photo in the middle of the run.
function groupFiltered(by) {
  const groups = [];
  let cur = null;
  const items = state.filtered;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (!a.taken_at) break;                       // undated items sort last
    const d = new Date(a.taken_at);
    const key = by === 'year' ? String(d.getFullYear()) : monthKeyOf(a.taken_at);
    if (!cur || cur.key !== key) { cur = { key, ms: a.taken_at, start: i, count: 0 }; groups.push(cur); }
    cur.count++;
  }
  for (const g of groups) {
    let cover = null, fallback = null;
    const mid = g.start + Math.floor(g.count / 2);
    for (let i = g.start; i < g.start + g.count && i < g.start + 4000; i++) {
      const a = items[i];
      if (a.kind !== 'photo') continue;
      if (a.fav) { cover = a; break; }
      if (!fallback || Math.abs(i - mid) < Math.abs(fallback.i - mid)) fallback = { a, i };
    }
    g.cover = (cover || (fallback && fallback.a) || items[g.start]).id;
  }
  const undated = items.length - (groups.length ? groups[groups.length - 1].start + groups[groups.length - 1].count : 0);
  return { groups, undated, undatedStart: items.length - undated };
}
function renderZoomView() {
  const view = libView;
  const host = $(view === 'years' ? 'libYears' : 'libMonths');
  host.style.paddingTop = libTopInset() + 'px';
  host.style.paddingBottom = libBottomInset() + 'px';
  host.textContent = '';
  const { groups, undated, undatedStart } = groupFiltered(view === 'years' ? 'year' : 'month');
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'zoom-card ' + (view === 'years' ? 'year-card' : 'month-card');
    card.dataset.key = g.key;
    card.appendChild(progressiveImg(g.cover, 'preview'));
    const t = document.createElement('div');
    t.className = 'zc-text';
    t.innerHTML = `<b>${view === 'years' ? g.key : escapeHtml(fmtMon(g.ms))}</b><span>${plural(g.count, 'item')}</span>`;
    card.appendChild(t);
    card.addEventListener('click', () => {
      if (view === 'years') setLibView('months', { scrollToMs: g.ms });
      else setLibView('all', { scrollToIdx: g.start });
    });
    frag.appendChild(card);
  }
  if (undated > 0) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'zoom-card month-card';
    card.style.height = '120px';
    card.appendChild(progressiveImg(state.filtered[undatedStart].id, 'preview'));
    const t = document.createElement('div');
    t.className = 'zc-text';
    t.innerHTML = `<b>No date</b><span>${plural(undated, 'item')}</span>`;
    card.appendChild(t);
    card.addEventListener('click', () => setLibView('all', { scrollToIdx: undatedStart }));
    frag.appendChild(card);
  }
  host.appendChild(frag);
}

// ── Scrubber ──────────────────────────────────────────────────────────────
const scrub = { el: $('libScrubber'), handle: $('scrubHandle'), label: $('scrubLabel'), hideT: null, dragging: false };
let scrubYearsCache = null;
function scrubUsable() { return libView === 'all' && libScroll.scrollHeight > libScroll.clientHeight * 3; }
function scrubTrackH() { return scrub.el.clientHeight - scrub.handle.offsetHeight; }
function scrubberOnScroll() {
  if (!scrubUsable()) { scrub.el.classList.remove('show'); return; }
  positionScrubHandle();
  if (!scrub.dragging) {
    scrub.el.classList.add('show');
    clearTimeout(scrub.hideT);
    scrub.hideT = setTimeout(() => scrub.el.classList.remove('show'), 1400);
  }
}
function positionScrubHandle() {
  const max = Math.max(1, libScroll.scrollHeight - libScroll.clientHeight);
  const y = (libScroll.scrollTop / max) * scrubTrackH();
  scrub.handle.style.transform = `translateY(${Math.round(y)}px)`;
}
function scrubYears() {
  if (scrubYearsCache) return scrubYearsCache;
  const out = [];
  let lastYear = null;
  const max = Math.max(1, libScroll.scrollHeight - libScroll.clientHeight);
  for (let i = 0; i < state.filtered.length; i++) {
    const t = state.filtered[i].taken_at;
    if (!t) break;
    const y = new Date(t).getFullYear();
    if (y !== lastYear) { lastYear = y; out.push({ year: y, frac: clamp((libGrid.contentY(i) - libGrid.padTop) / max, 0, 1) }); }
  }
  return (scrubYearsCache = out);
}
function renderScrubYears() {
  const host = $('scrubYears');
  const H = scrubTrackH(), hh = scrub.handle.offsetHeight;
  let lastY = -100, html = '';
  for (const y of scrubYears()) {
    const py = y.frac * H + hh / 2;
    if (py - lastY < 18) continue;
    lastY = py;
    html += `<span class="scrub-year" style="top:${Math.round(py)}px">${y.year}</span>`;
  }
  host.innerHTML = html;
}
(function wireScrubber() {
  let startY = 0, startTop = 0, pid = null;
  const toScroll = (clientY) => {
    const r = scrub.el.getBoundingClientRect();
    const frac = clamp((clientY - r.top - scrub.handle.offsetHeight / 2) / Math.max(1, scrubTrackH()), 0, 1);
    libScroll.scrollTop = frac * (libScroll.scrollHeight - libScroll.clientHeight);
    const it = state.filtered[libGrid.indexAtContentY(libScroll.scrollTop + libGrid.padTop + 4)];
    scrub.label.textContent = it ? (it.taken_at ? fmtMonShort(it.taken_at) : 'No date') : '';
  };
  scrub.handle.addEventListener('pointerdown', (e) => {
    if (!scrub.el.classList.contains('show')) return;
    e.preventDefault();
    pid = e.pointerId;
    scrub.dragging = true;
    scrub.el.classList.add('dragging');
    clearTimeout(scrub.hideT);
    try { scrub.handle.setPointerCapture(pid); } catch (_) {}
    startY = e.clientY; startTop = libScroll.scrollTop;
    renderScrubYears();
    toScroll(e.clientY);
    if (navigator.vibrate) { try { navigator.vibrate(5); } catch (_) {} }
  });
  scrub.handle.addEventListener('pointermove', (e) => { if (scrub.dragging && e.pointerId === pid) { e.preventDefault(); toScroll(e.clientY); } });
  const end = () => {
    if (!scrub.dragging) return;
    scrub.dragging = false;
    scrub.el.classList.remove('dragging');
    scrub.hideT = setTimeout(() => scrub.el.classList.remove('show'), 1200);
  };
  scrub.handle.addEventListener('pointerup', end);
  scrub.handle.addEventListener('pointercancel', end);
  void startY; void startTop;
})();

// ── Screen hooks ──────────────────────────────────────────────────────────
registerScreen('library', {
  enter() {
    if (libView === 'all') { if (libGrid.dirty || !libGrid.cellW) libGrid.relayout(); else libGrid.paint(); }
    updateLibSubtitle(true);
  },
  reselect() {
    if (libView !== 'all') { setLibView('all'); return; }
    libScroll.scrollTo({ top: 0, behavior: 'smooth' });
  },
});
window.addEventListener('resize', debounce(() => {
  scrubYearsCache = null;
  if (libView !== 'all' && $('screen-library').classList.contains('active')) {
    const host = $(libView === 'years' ? 'libYears' : 'libMonths');
    host.style.paddingTop = libTopInset() + 'px';
  }
}, 150));
