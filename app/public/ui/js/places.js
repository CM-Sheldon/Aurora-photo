/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — places.js
   Full-bleed world map (Aurora's own offline country outlines) with photo
   pins. Pins cluster in WORLD space at a quantised cell size, so panning only
   moves pins (keyed DOM reuse) and only a zoom-bucket change rebuilds them.
   Tap a pin → place sheet (preview strip + "Show all"). The date chip filters
   pins: instantly by each place's date span, then by exact counts.
   ════════════════════════════════════════════════════════════════════════ */

const MAP_W = 1000, MAP_H = 500;
function projectLonLat(lon, lat) { return [(lon + 180) / 360 * MAP_W, (90 - lat) / 180 * MAP_H]; }

// World outlines are fetched once (also used by the viewer's mini map).
let worldPathsPromise = null, worldLabels = [];
function ensureWorldPaths() {
  if (!worldPathsPromise) {
    // ?v=build: /worldmap is cached for 24h, so a projection fix must bust it.
    worldPathsPromise = getJSON('/api/aurora/worldmap?v=' + encodeURIComponent(PAGE_BUILD))
      .then(wm => { worldLabels = wm.labels || []; return wm.paths || []; })
      .catch(() => { worldPathsPromise = null; return null; });
  }
  return worldPathsPromise;
}
let worldMapRendered = false;
async function renderWorldMap() {
  if (worldMapRendered) return;
  const paths = await ensureWorldPaths();
  if (!paths) return;
  $('worldMap').innerHTML = paths.map(d => `<path d="${d}"/>`).join('');
  worldMapRendered = true;
}

let mapView = null, mapHome = null, mapAR = 1, mapPlaces = [];
let placesLoadedAt = 0, placesLoading = null;
let placesRange = null, placesRangeCounts = null, placesFetchSeq = 0, placesFetchTimer = null;
let pendingFocus = null;                  // { lat, lon, placeId } from the viewer's mini map

async function loadPlaces(force) {
  if (placesLoading) return placesLoading;
  if (!force && mapPlaces.length && Date.now() - placesLoadedAt < 3 * 60 * 1000) { onPlacesReady(); return; }
  placesLoading = (async () => {
    try {
      await renderWorldMap();
      // hideRaw MUST be passed so pin counts match what the sheet + Show all return.
      const places = await getJSON('/api/aurora/places' + (state.hideRaw ? '?hideRaw=1' : ''));
      $('navBadgePlaces').textContent = places.length.toLocaleString();
      const pts = [];
      for (const p of places) {
        if (p.lat == null || p.lon == null) continue;
        const [x, y] = projectLonLat(p.lon, p.lat);
        pts.push({ p, x, y });
      }
      mapPlaces = pts;
      placesLoadedAt = Date.now();
      $('mapPlaceholder').hidden = pts.length > 0;
      $('worldMap').style.display = pts.length ? '' : 'none';
      if (!pts.length) { $('placePins').innerHTML = ''; return; }
      fitHome();
      if (!mapView) mapView = { ...mapHome };
      setupMapInteractions();
      updatePlacesRangeLabel();
      onPlacesReady();
    } catch (_) {
      $('mapPlaceholder').hidden = false;
    } finally { placesLoading = null; }
  })();
  return placesLoading;
}
function onPlacesReady() {
  syncMapAspect();
  if (pendingFocus) { const f = pendingFocus; pendingFocus = null; focusMapOn(f); }
  else applyMapView(true);
}
// Home view = bounding box of every place, padded, matched to the screen's aspect.
function fitHome() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of mapPlaces) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const padX = (maxX - minX) * 0.25 + 14, padY = (maxY - minY) * 0.35 + 14;
  let vbX = minX - padX, vbY = minY - padY, vbW = (maxX - minX) + 2 * padX, vbH = (maxY - minY) + 2 * padY;
  const area = $('mapArea');
  const arc = (area.clientWidth || 800) / (area.clientHeight || 500);
  if (arc > vbW / vbH) { const nw = vbH * arc; vbX -= (nw - vbW) / 2; vbW = nw; }
  else { const nh = vbW / arc; vbY -= (nh - vbH) / 2; vbH = nh; }
  mapHome = { x: vbX, y: vbY, w: vbW, h: vbH };
  mapAR = vbW / vbH;
}
// Keep the view's aspect equal to the container's (rotation, resize).
function syncMapAspect() {
  if (!mapView) return;
  const area = $('mapArea');
  if (!area.clientWidth) return;
  const ar = area.clientWidth / area.clientHeight;
  if (Math.abs(ar - mapAR) < 0.001) return;
  const cy = mapView.y + mapView.h / 2;
  mapAR = ar;
  mapView.h = mapView.w / ar;
  mapView.y = cy - mapView.h / 2;
  fitHome();
}

let pinsRaf = false;
function applyMapView(now) {
  if (!mapView) return;
  $('worldMap').setAttribute('viewBox', `${mapView.x} ${mapView.y} ${mapView.w} ${mapView.h}`);
  if (now) { renderMapPins(); renderCountryLabels(); return; }
  if (!pinsRaf) {
    pinsRaf = true;
    requestAnimationFrame(() => { pinsRaf = false; renderMapPins(); renderCountryLabels(); });
  }
}

function renderCountryLabels() {
  const layer = $('mapLabels');
  if (!layer || !mapView) return;
  const area = $('mapArea');
  const w = area.clientWidth || 800, h = area.clientHeight || 500;
  const occupied = new Set();
  let shown = 0, html = '';
  for (const lb of worldLabels) {
    if (shown >= 12) break;
    const sx = (lb.x - mapView.x) / mapView.w * w, sy = (lb.y - mapView.y) / mapView.h * h;
    if (sx < 0 || sy < 0 || sx > w || sy > h) continue;
    if (lb.r / mapView.w * w < 60) continue;
    const key = Math.floor(sx / 110) + ':' + Math.floor(sy / 70);
    if (occupied.has(key)) continue;
    occupied.add(key);
    html += `<div class="country-label" style="left:${sx.toFixed(1)}px;top:${sy.toFixed(1)}px">${escapeHtml(lb.name)}</div>`;
    shown++;
  }
  layer.innerHTML = html;
}

// ── Pins ──────────────────────────────────────────────────────────────────
const pinEls = new Map();          // cluster key → element
let activePinKey = null;
function renderMapPins() {
  if (!mapView) return;
  const area = $('mapArea'), host = $('placePins');
  const w = area.clientWidth || 800, h = area.clientHeight || 500;
  const pxPerUnit = w / mapView.w;
  // ~76px cells, quantised to powers of 1.6 so clusters don't reshuffle mid-pan.
  const cell = Math.pow(1.6, Math.round(Math.log(76 / pxPerUnit) / Math.log(1.6)));
  const cells = new Map();
  for (const mp of mapPlaces) {
    let cnt = mp.p.count;
    if (placesRangeCounts) {
      if (!placesRangeCounts.has(mp.p.id)) continue;
      cnt = placesRangeCounts.get(mp.p.id);
    } else if (placesRange) {
      if (!(mp.p.first_date <= placesRange.toMs && mp.p.last_date >= placesRange.fromMs)) continue;
    }
    if (!cnt) continue;
    const key = cell.toFixed(5) + '|' + Math.floor(mp.x / cell) + ':' + Math.floor(mp.y / cell);
    let c = cells.get(key);
    if (!c) { c = { key, places: [], count: 0, wx: 0, wy: 0, wsum: 0, top: null }; cells.set(key, c); }
    c.places.push(mp.p); c.count += cnt;
    // Count-weighted centre, so a cluster sits where most of its photos are.
    c.wx += mp.x * cnt; c.wy += mp.y * cnt; c.wsum += cnt;
    if (!c.top || cnt > c.topCount) { c.top = mp.p; c.topCount = cnt; }
  }
  const want = new Set();
  const visible = [];
  for (const c of cells.values()) {
    const sx = (c.wx / c.wsum - mapView.x) * pxPerUnit, sy = (c.wy / c.wsum - mapView.y) * pxPerUnit;
    if (sx < -60 || sy < -20 || sx > w + 60 || sy > h + 90) continue;
    visible.push({ c, sx, sy });
  }
  const labelOn = visible.length <= 14;
  const labelCells = new Set();
  visible.sort((a, b) => b.c.count - a.c.count);
  for (const { c, sx, sy } of visible) {
    want.add(c.key);
    let el = pinEls.get(c.key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'ppin';
      const cover = c.top && c.top.cover_id;
      el.innerHTML = `<div class="ph">${cover ? `<img alt="" decoding="async" src="${thumbUrl(cover)}">` : ''}</div><span class="n"></span><div class="tail"></div>`;
      wirePin(el);
      host.appendChild(el);
      pinEls.set(c.key, el);
    }
    el._cluster = c;
    el.querySelector('.n').textContent = c.count >= 10000 ? Math.round(c.count / 1000) + 'k' : c.count >= 1000 ? (c.count / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : c.count;
    el.classList.toggle('small', c.count < 5 && visible.length > 20);
    el.classList.toggle('active', c.key === activePinKey);
    el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
    el.style.zIndex = c.key === activePinKey ? 50 : String(Math.min(40, 2 + Math.round(Math.log10(c.count + 1) * 6)));
    // Names under single-place pins once only a few pins are on screen.
    let lab = el.querySelector('.ppin-label');
    const single = c.places.length === 1;
    const lk = Math.floor(sx / 120) + ':' + Math.floor(sy / 60);
    const showLabel = labelOn && single && !labelCells.has(lk);
    if (showLabel) {
      labelCells.add(lk);
      if (!lab) { lab = document.createElement('div'); lab.className = 'ppin-label'; el.appendChild(lab); }
      lab.textContent = c.places[0].name || c.places[0].country || '';
    } else if (lab) lab.remove();
  }
  for (const [key, el] of pinEls) if (!want.has(key)) { el.remove(); pinEls.delete(key); }
}
// Tap = pointerdown → pointerup within a small slop (decoupled from map panning).
function wirePin(el) {
  const SLOP = 9;
  let down = null;
  el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; e.stopPropagation(); });
  el.addEventListener('pointermove', (e) => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > SLOP) down = null; });
  el.addEventListener('pointerup', (e) => {
    if (!down) return;
    down = null; e.stopPropagation();
    const c = el._cluster;
    if (!c) return;
    activePinKey = c.key;
    pinEls.forEach((p, k) => p.classList.toggle('active', k === c.key));
    showPlaceGallery(c.places);
  });
  el.addEventListener('pointercancel', () => { down = null; });
}

// ── Pan / zoom ────────────────────────────────────────────────────────────
function zoomMap(factor, cx, cy) {
  if (!mapView) return;
  const wx = mapView.x + cx * mapView.w, wy = mapView.y + cy * mapView.h;
  const nw = clamp(mapView.w * factor, 2.5, 1100), nh = nw / mapAR;
  mapView = { x: wx - cx * nw, y: wy - cy * nh, w: nw, h: nh };
  applyMapView();
}
function resetMapView() { if (mapHome) { mapView = { ...mapHome }; applyMapView(); } }
function mapZoomBtn(dir) { zoomMap(dir > 0 ? 0.68 : 1 / 0.68, 0.5, 0.5); }
let mapInteractionsReady = false;
function setupMapInteractions() {
  if (mapInteractionsReady) return;
  mapInteractionsReady = true;
  const area = $('mapArea');
  area.addEventListener('wheel', (e) => {
    if (!mapView) return;
    e.preventDefault();
    const r = area.getBoundingClientRect();
    zoomMap(e.deltaY < 0 ? 0.86 : 1 / 0.86, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });
  let dragging = false, lastX = 0, lastY = 0, pinching = false;
  area.addEventListener('pointerdown', (e) => {
    if (pinching || e.target.closest('.ppin')) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    try { area.setPointerCapture(e.pointerId); } catch (_) {}
    area.classList.add('grabbing');
  });
  area.addEventListener('pointermove', (e) => {
    if (!dragging || !mapView || pinching) return;
    const r = area.getBoundingClientRect();
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    mapView.x -= dx / r.width * mapView.w;
    mapView.y -= dy / r.height * mapView.h;
    applyMapView();
  });
  const end = () => { dragging = false; area.classList.remove('grabbing'); };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
  let pd = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  area.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { pinching = true; dragging = false; pd = dist(e.touches); } }, { passive: false });
  area.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !mapView) return;
    e.preventDefault();
    const r = area.getBoundingClientRect(), d = dist(e.touches);
    const mx = ((e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left) / r.width;
    const my = ((e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top) / r.height;
    if (pd > 0) zoomMap(pd / d, mx, my);
    pd = d;
  }, { passive: false });
  area.addEventListener('touchend', (e) => { if (e.touches.length < 2) { pinching = false; pd = 0; } });
  area.addEventListener('dblclick', (e) => {
    const r = area.getBoundingClientRect();
    zoomMap(0.55, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
}
// Centre the map on a point (from a photo's Info mini map).
function focusMapOn(f) {
  if (!mapView) return;
  const [x, y] = projectLonLat(f.lon, f.lat);
  const w = 7, h = w / mapAR;
  mapView = { x: x - w / 2, y: y - h * 0.42, w, h };
  applyMapView(true);
  if (f.placeId) {
    const mp = mapPlaces.find(m => m.p.id === f.placeId);
    if (mp) showPlaceGallery([mp.p]);
  }
}
function openPlacesAt(lat, lon, placeId) {
  pendingFocus = { lat, lon, placeId };
  switchScreen('places');
}

// ── Date filter ───────────────────────────────────────────────────────────
state.placesFrom = 0; state.placesTo = 0;
function placesRangeFull() { return state.placesFrom <= 0 && state.placesTo >= state.totalMonths - 1; }
function updatePlacesRangeLabel() {
  if (!state.placesTo || state.placesTo > state.totalMonths - 1) state.placesTo = state.totalMonths - 1;
  $('pTimeRangeLabel').textContent = placesRangeFull() ? 'All time' : monthRangeLabel(state.placesFrom, state.placesTo);
  $('placesRangeBtn').classList.toggle('accent', !placesRangeFull());
}
function openPlacesRange() {
  openRangeSheet({
    title: 'Show places from', from: state.placesFrom, to: state.placesTo,
    onChange: (f, t) => { state.placesFrom = f; state.placesTo = t; updatePlacesRangeLabel(); applyPlacesRange(); },
  });
}
function applyPlacesRange() {
  if (placesRangeFull()) {
    placesRange = null; placesRangeCounts = null;
    clearTimeout(placesFetchTimer); placesFetchSeq++;
    renderMapPins();
    return;
  }
  const fromMs = addMonths(state.monthBase, state.placesFrom);
  const toMs = addMonths(state.monthBase, state.placesTo + 1) - 1;
  placesRange = { fromMs, toMs };
  placesRangeCounts = null;                 // instant overlap test until exact counts land
  renderMapPins();
  const seq = ++placesFetchSeq;
  clearTimeout(placesFetchTimer);
  placesFetchTimer = setTimeout(async () => {
    try {
      const rows = await getJSON(`/api/aurora/places?from=${fromMs}&to=${toMs}` + (state.hideRaw ? '&hideRaw=1' : ''));
      if (seq !== placesFetchSeq) return;
      placesRangeCounts = new Map(rows.map(p => [p.id, p.count]));
      renderMapPins();
    } catch (_) {}
  }, 200);
}

// ── Place sheet ───────────────────────────────────────────────────────────
let placeFetchCtrl = null, placeFetchSeq = 0;
const placeSheet = $('placeDetail');
makeSheetDraggable(placeSheet, [$('placeSheetGrab'), placeSheet.querySelector('.ps-head')], () => closePlaceSheet());
function closePlaceSheet() {
  placeSheet.classList.remove('open');
  activePinKey = null;
  pinEls.forEach(p => p.classList.remove('active'));
}
async function showPlaceGallery(places) {
  if (!places || !places.length) return;
  placeSheet.classList.add('open');
  const single = places.length === 1;
  const range = placesRange ? { from: placesRange.fromMs, to: placesRange.toMs } : null;
  const firsts = places.map(p => p.first_date).filter(Boolean), lasts = places.map(p => p.last_date).filter(Boolean);
  let firstDate = firsts.length ? Math.min(...firsts) : null, lastDate = lasts.length ? Math.max(...lasts) : null;
  if (range) { if (firstDate) firstDate = Math.max(firstDate, range.from); if (lastDate) lastDate = Math.min(lastDate, range.to); }
  const ids = places.map(p => p.id).join(',');
  // A cluster is named after its country, or its biggest country "& nearby".
  const byCountry = new Map();
  for (const p of places) if (p.country) byCountry.set(p.country, (byCountry.get(p.country) || 0) + (p.count || 0));
  const topCountry = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])[0];
  const name = single ? (places[0].name || places[0].country || 'Unknown place')
    : byCountry.size === 1 ? topCountry : topCountry ? `${topCountry} & nearby` : `${places.length} places`;
  $('placeDetailName').textContent = name;
  state.placeSelection = { ids, name, range, firstDate, lastDate };
  const grid = $('placeDetailGrid'), meta = $('placeDetailMeta'), btn = $('placeViewAllBtn');
  meta.textContent = single && places[0].country && places[0].name ? places[0].country : 'Loading…';
  btn.disabled = true; btn.textContent = 'Show all';
  grid.innerHTML = '';
  if (placeFetchCtrl) { try { placeFetchCtrl.abort(); } catch (_) {} }
  placeFetchCtrl = new AbortController();
  const mySeq = ++placeFetchSeq;
  try {
    const rangeQs = range ? `&from=${range.from}&to=${range.to}` : '';
    const res = await getJSON(`/api/aurora/assets?place=${ids}&limit=16&count=1${rangeQs}${state.hideRaw ? '&hideRaw=1' : ''}`, { signal: placeFetchCtrl.signal });
    if (mySeq !== placeFetchSeq) return;
    const total = res.total != null ? res.total : res.assets.length;
    state.placeSelection.total = total;
    const span = firstDate && lastDate ? ` · ${fmtMonShort(firstDate)}${fmtMonShort(firstDate) !== fmtMonShort(lastDate) ? ' – ' + fmtMonShort(lastDate) : ''}` : '';
    meta.textContent = `${plural(total, 'item')}${span}`;
    btn.disabled = total === 0;
    btn.textContent = total ? `Show all ${total.toLocaleString()}` : 'Nothing to show';
    const items = res.assets || [];
    grid.innerHTML = items.length ? '' : '<span class="ps-note">No viewable photos here</span>';
    items.forEach((a, idx) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'ps-thumb';
      t.innerHTML = `<img alt="" decoding="async" src="${thumbUrl(a.id)}">${a.kind === 'video' && a.duration_s ? `<span class="t-dur">${fmtDuration(a.duration_s)}</span>` : ''}`;
      t.addEventListener('click', () => openLightboxWith(items, idx, { fromRect: t.getBoundingClientRect() }));
      grid.appendChild(t);
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (mySeq === placeFetchSeq) { grid.innerHTML = '<span class="ps-note">Couldn’t load photos</span>'; meta.textContent = ''; }
  }
}
function placeViewAll() {
  const sel = state.placeSelection;
  if (!sel || !sel.ids) return;
  const span = sel.firstDate && sel.lastDate ? fmtMonShort(sel.firstDate) + (fmtMonShort(sel.firstDate) !== fmtMonShort(sel.lastDate) ? ' – ' + fmtMonShort(sel.lastDate) : '') : '';
  const rangeQs = sel.range ? `&from=${sel.range.from}&to=${sel.range.to}` : '';
  openDetail({
    kind: 'place', title: sel.name,
    sub: [sel.total != null ? plural(sel.total, 'item') : '', span].filter(Boolean).join(' · '),
    pageUrl: `/api/aurora/assets?place=${sel.ids}${rangeQs}`,
    total: sel.total,
  });
}

registerScreen('places', {
  enter() { loadPlaces(); },
  leave() { closePlaceSheet(); },
  reselect() { closePlaceSheet(); resetMapView(); },
});
window.addEventListener('resize', debounce(() => {
  if (state.screen !== 'places' || !mapView) return;
  syncMapAspect();
  applyMapView(true);
}, 120));
