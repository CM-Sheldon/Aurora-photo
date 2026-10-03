/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — viewer.js
   The photo/video viewer and its info sheet.

   Layers:  #lightboxStage  ← open/close zoom + drag-to-dismiss transforms
            #lightboxImg    ← pinch / double-tap / pan zoom transform
   Gestures (touch): swipe ← → pages, swipe ↓ closes (photo shrinks back into
   its tile), swipe ↑ opens Info, tap toggles chrome, double-tap / pinch zooms,
   press-and-hold plays a Live Photo. Mouse: arrows, wheel zoom, dbl-click.
   ════════════════════════════════════════════════════════════════════════ */

const lb = $('lightbox'), lbStage = $('lightboxStage'), lbImg = $('lightboxImg'), lbVid = $('lightboxVideo'), lbBg = $('viewerBg');
const lbPreloadCache = new Map();
const LB_PRELOAD_LIMIT = 12;
const assetCache = new Map();             // id → /asset/:id payload (LRU-ish)
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function viewerOpen() { return lb.classList.contains('open'); }
function currentItem() { return state.lightboxItems[state.lightboxIdx]; }

async function getAssetDetails(id, fresh) {
  if (!fresh && assetCache.has(id)) return assetCache.get(id);
  const a = await getJSON(`/api/aurora/asset/${id}`);
  assetCache.set(id, a);
  if (assetCache.size > 300) assetCache.delete(assetCache.keys().next().value);
  return a;
}

function lbPreload(item) {
  if (!item || item.kind === 'video' || lbPreloadCache.has(item.id)) return;
  if (lbPreloadCache.size >= LB_PRELOAD_LIMIT) lbPreloadCache.delete(lbPreloadCache.keys().next().value);
  const pre = new Image();
  pre.decoding = 'async';
  pre.src = thumbUrl(item.id, 'full');
  lbPreloadCache.set(item.id, pre);
}

// ── Open / close ──────────────────────────────────────────────────────────
function openLightboxFromGrid(grid, idx) {
  state.lightboxItems = grid.items;
  state.lightboxGrid = grid;
  openLightbox(idx, { fromRect: grid.tileRect(idx) });
}
function openLightboxWith(items, idx, opts) {
  state.lightboxItems = items;
  state.lightboxGrid = null;
  openLightbox(idx, opts || {});
}

function openLightbox(idx, opts = {}) {
  const item = state.lightboxItems[idx];
  if (!item) return;
  const wasOpen = viewerOpen();
  const dir = wasOpen ? Math.sign(idx - state.lightboxIdx) : 0;
  state.lightboxIdx = idx;
  if (!wasOpen) {
    lb.classList.add('open');
    lb.classList.remove('chrome-hidden', 'fill', 'closing');
    lb.setAttribute('aria-hidden', 'false');
    document.body.classList.add('viewer-open');
    animateOpen(opts.fromRect);
  }
  resetLightboxZoom();
  stopLive();
  lb.classList.toggle('is-video', item.kind === 'video');

  if (item.kind === 'video') {
    lbImg.removeAttribute('src');
    lbVid.setAttribute('controls', '');
    lbVid.loop = false; lbVid.muted = false;
    clearVideoOrientation();
    lbVid.onloadedmetadata = () => applyVideoOrientation(item);
    lbVid.src = `/api/aurora/video/${item.id}`;
    lbVid.play().catch(() => {});
  } else {
    clearVideoOrientation();
    lbVid.onloadedmetadata = null;
    lbVid.pause(); lbVid.removeAttribute('src'); lbVid.load();
    const cached = lbPreloadCache.get(item.id);
    if (cached && cached.complete && cached.naturalWidth) {
      lbImg.src = cached.src;
    } else {
      // Grid thumb instantly (already cached by the tile), full size when loaded.
      lbImg.src = thumbUrl(item.id, 'grid');
      const full = cached || new Image();
      if (!cached) { full.decoding = 'async'; full.src = thumbUrl(item.id, 'full'); lbPreloadCache.set(item.id, full); }
      const swap = () => { if (state.lightboxIdx === idx && currentItem() === item) lbImg.src = full.src; };
      full.onload = swap;
      if (full.complete && full.naturalWidth) swap();
    }
    if (dir && !opts.fromFilm && !reducedMotion()) {
      lbImg.classList.remove('slide-in-next', 'slide-in-prev');
      void lbImg.offsetWidth;
      lbImg.classList.add(dir > 0 ? 'slide-in-next' : 'slide-in-prev');
    }
    for (let d = 1; d <= 2; d++) { lbPreload(state.lightboxItems[idx - d]); lbPreload(state.lightboxItems[idx + d]); }
  }

  $('lbLiveBtn').hidden = !(item.kind === 'photo' && item.live_video_id);
  $('lbPrev').style.visibility = idx > 0 ? 'visible' : 'hidden';
  $('lbNext').style.visibility = idx < state.lightboxItems.length - 1 ? 'visible' : 'hidden';
  syncViewerFav();
  renderViewerTitle(item);
  if (!opts.fromFilm) renderFilm(idx);
  if ($('metaPanel').classList.contains('open')) loadMetaPanel(item.id);

  // Page in more results while swiping through a paged grid.
  const g = state.lightboxGrid;
  if (g && g.hasMore && !g.loadingMore && idx >= state.lightboxItems.length - 6 && g.opts.onNearEnd) {
    g.loadingMore = true;
    Promise.resolve(g.opts.onNearEnd(g)).finally(() => { g.loadingMore = false; renderFilm(state.lightboxIdx); });
  }
}

// Title: place name (when known) over date · time.
let _titleSeq = 0;
function renderViewerTitle(item) {
  const t = $('lightboxTitle'), s = $('lightboxSub');
  const setFrom = (place) => {
    if (place) { t.textContent = place; s.textContent = item.taken_at ? `${fmtDate(item.taken_at)} · ${fmtTime(item.taken_at)}` : ''; }
    else if (item.taken_at) {
      t.textContent = new Date(item.taken_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      s.textContent = new Date(item.taken_at).toLocaleDateString('en-GB', { weekday: 'long' }) + ' · ' + fmtTime(item.taken_at);
    } else { t.textContent = 'No date'; s.textContent = ''; }
  };
  const known = item.place_name || item.place_country;
  setFrom(known ? item.place_name || item.place_country : null);
  if (known || assetCache.has(item.id)) {
    const a = assetCache.get(item.id);
    if (a && !known) setFrom(a.place_name || a.place_country || null);
    return;
  }
  const seq = ++_titleSeq;
  setTimeout(async () => {
    if (seq !== _titleSeq || currentItem() !== item) return;
    try {
      const a = await getAssetDetails(item.id);
      if (seq === _titleSeq && currentItem() === item && (a.place_name || a.place_country)) setFrom(a.place_name || a.place_country);
    } catch (_) {}
  }, 140);
}

function animateOpen(rect) {
  lbStage.classList.add('no-anim');
  lbStage.style.transform = '';
  lbBg.style.opacity = '';
  if (!rect || reducedMotion()) {
    lbStage.classList.remove('no-anim');
    lb.classList.add('opening');
    setTimeout(() => lb.classList.remove('opening'), 320);
    return;
  }
  const W = window.innerWidth, H = window.innerHeight;
  const dx = rect.left + rect.width / 2 - W / 2, dy = rect.top + rect.height / 2 - H / 2;
  const s = Math.max(0.08, rect.width / W);
  lbStage.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
  lbBg.style.opacity = '0';
  void lbStage.offsetWidth;
  lbStage.classList.remove('no-anim');
  requestAnimationFrame(() => {
    lbStage.style.transform = '';
    lbBg.style.transition = 'opacity 0.3s';
    lbBg.style.opacity = '1';
    setTimeout(() => { lbBg.style.transition = ''; lbBg.style.opacity = ''; }, 320);
  });
}

// closeLightbox(true) skips the zoom back into the tile — used when the
// viewer hands off to another screen or the item just left the grid.
function closeLightbox(instant) {
  if (!viewerOpen() || lb.classList.contains('closing')) return;
  instant = instant === true;              // ignore event objects from listeners
  closeMetaPanel(true);
  stopLive();
  lbVid.pause();
  const g = state.lightboxGrid, idx = state.lightboxIdx;
  let rect = null;
  if (!instant && g && g.isShown()) { g.ensureVisible(idx); rect = g.tileRect(idx); }
  const finish = () => {
    lb.classList.remove('open', 'closing', 'fill', 'chrome-hidden', 'is-video', 'dragging', 'info-open', 'zoomed');
    lb.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('viewer-open');
    lbStage.classList.add('no-anim');
    lbStage.style.transform = '';
    lbBg.style.opacity = '';
    lbVid.removeAttribute('src'); lbVid.load(); lbVid.onloadedmetadata = null; lbVid.classList.remove('live-overlay');
    clearVideoOrientation();
    resetLightboxZoom();
    requestAnimationFrame(() => lbStage.classList.remove('no-anim'));
    if (g) { const t = g.tileEl(idx); if (t && rect) { t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); } }
  };
  if (instant) { finish(); return; }
  lb.classList.add('closing');
  if (rect && !reducedMotion()) {
    const W = window.innerWidth, H = window.innerHeight;
    const dx = rect.left + rect.width / 2 - W / 2, dy = rect.top + rect.height / 2 - H / 2;
    lbStage.classList.remove('no-anim');
    lbStage.style.transform = `translate(${dx}px, ${dy}px) scale(${Math.max(0.08, rect.width / W)})`;
    setTimeout(finish, 300);
  } else {
    lbStage.style.transition = 'opacity 0.2s';
    lbStage.style.opacity = '0';
    setTimeout(() => { lbStage.style.transition = ''; lbStage.style.opacity = ''; finish(); }, 200);
  }
}

function lightboxNav(dir) {
  const next = state.lightboxIdx + dir;
  if (next < 0 || next >= state.lightboxItems.length) return false;
  openLightbox(next);
  return true;
}

function toggleLightboxFit() {
  lb.classList.toggle('fill');
  const item = currentItem();
  if (item && item.kind === 'video') applyVideoOrientation(item);
}

// ── Video orientation (Android decodes portrait clips landscape) ─────────
function clearVideoOrientation() {
  lbVid.classList.remove('rotated');
  lbVid.style.transform = ''; lbVid.style.width = ''; lbVid.style.height = ''; lbVid.style.objectFit = '';
}
function applyVideoOrientation(item) {
  clearVideoOrientation();
  if (!item || item.kind !== 'video' || lbVid.classList.contains('live-overlay')) return;
  const rot = ((item.rotation || 0) % 360 + 360) % 360;
  if (rot !== 90 && rot !== 270) return;
  const vw = lbVid.videoWidth, vh = lbVid.videoHeight;
  if (!vw || !vh || vh > vw) return;           // not loaded, or the browser already rotated it
  const stage = lbStage.getBoundingClientRect();
  lbVid.style.width = stage.height + 'px';
  lbVid.style.height = stage.width + 'px';
  lbVid.style.objectFit = lb.classList.contains('fill') ? 'cover' : 'contain';
  lbVid.style.transform = 'rotate(' + rot + 'deg)';
  lbVid.classList.add('rotated');
}
window.addEventListener('resize', () => {
  if (lbVid.classList.contains('rotated')) applyVideoOrientation(currentItem());
  if (viewerOpen()) renderFilm(state.lightboxIdx);
});

// ── Live Photos ───────────────────────────────────────────────────────────
// Tap LIVE → play once. Press and hold the photo → play while held.
function playLive(opts = {}) {
  const item = currentItem();
  if (!item || !item.live_video_id) return;
  const pill = $('lbLiveBtn');
  pill.classList.add('playing');
  lbVid.removeAttribute('controls');
  lbVid.loop = !!opts.hold; lbVid.muted = false;
  lbVid.classList.add('live-overlay');
  lbVid.src = `/api/aurora/video/${item.live_video_id}`;
  try { lbVid.currentTime = 0; } catch (_) {}
  lbVid.play().catch(() => {});
  lbVid.onended = () => { if (!lbVid.loop) stopLive(); };
}
function stopLive() {
  if (!lbVid.classList.contains('live-overlay')) return;
  lbVid.onended = null;
  lbVid.pause(); lbVid.removeAttribute('src'); lbVid.load();
  lbVid.classList.remove('live-overlay');
  lbVid.loop = false;
  $('lbLiveBtn').classList.remove('playing');
}

// ── Favourite / share / album / more ──────────────────────────────────────
function syncViewerFav() {
  const item = currentItem();
  const b = $('lbFavBtn');
  if (!b || !item) return;
  b.classList.toggle('on', !!item.fav);
  b.innerHTML = ic(item.fav ? 'heart-fill' : 'heart');
  b.setAttribute('aria-label', item.fav ? 'Unfavourite' : 'Favourite');
}
function lightboxToggleFav() { const item = currentItem(); if (item) toggleFavItem(item); }
function lightboxShare() { const item = currentItem(); if (item) shareIds([item.id]); }
function lightboxAddToAlbum() { const item = currentItem(); if (item) pickAlbumFor([item.id]); }
async function openLightboxMore(anchor) {
  const item = currentItem();
  if (!item) return;
  let a = assetCache.get(item.id);
  const menu = () => openMenu(anchor, [
    { label: 'Play Live Photo', icon: 'live', hidden: !(item.kind === 'photo' && item.live_video_id), onClick: () => playLive() },
    { label: 'Add tag', icon: 'tag', hidden: !havePerm('photos.tag'), onClick: () => { openMetaPanel(); setTimeout(showTagInput, 350); } },
    { label: lb.classList.contains('fill') ? 'Fit to screen' : 'Fill screen', icon: 'expand', onClick: toggleLightboxFit },
    { label: 'Download original', icon: 'download', hidden: !havePerm('photos.download'), onClick: () => downloadIds([item.id]) },
    { sep: true },
    { label: a && a.hidden ? 'Unhide' : 'Hide', icon: a && a.hidden ? 'unlock' : 'lock', hidden: !havePerm('photos.hidden'),
      onClick: () => togglePrivatePhoto(item.id, !!(a && a.hidden)) },
    { label: a && a.removed ? 'Restore to library' : 'Remove from library', icon: a && a.removed ? 'restore' : 'trash',
      danger: !(a && a.removed), hidden: !havePerm('photos.delete'),
      onClick: () => (a && a.removed ? restoreRemoved(item.id) : removeAssetFromLibrary(item.id)) },
  ]);
  if (!a) { try { a = await getAssetDetails(item.id); } catch (_) {} }
  menu();
}

// ── Filmstrip ─────────────────────────────────────────────────────────────
const film = { el: $('lbFilm'), track: $('lbFilmTrack'), start: 0, end: 0, pitch: 32, programmatic: false, timer: null, center: -1 };
function renderFilm(idx) {
  const items = state.lightboxItems;
  if (!items || items.length < 2) { film.el.hidden = true; return; }
  film.el.hidden = false;
  if (!(idx - film.start >= 12 && film.end - idx >= 12 && film.track.childElementCount)) {
    film.start = Math.max(0, idx - 60);
    film.end = Math.min(items.length - 1, idx + 60);
    // Pads let the first/last thumbs reach the centre (px — a % of a max-content track is 0).
    const pad = `<div class="film-pad" style="width:${Math.max(0, Math.round(film.el.clientWidth / 2 - 15))}px"></div>`;
    let h = pad;
    for (let i = film.start; i <= film.end; i++) {
      h += `<img class="film-item" data-i="${i}" loading="lazy" decoding="async" alt="" src="${thumbUrl(items[i].id)}">`;
    }
    film.track.innerHTML = h + pad;
  }
  // Re-measure the centring pads every time: the strip narrows when Info opens on desktop.
  const padW = Math.max(0, Math.round(film.el.clientWidth / 2 - 15)) + 'px';
  film.track.querySelectorAll('.film-pad').forEach(p => { p.style.width = padW; });
  film.center = idx;
  film.track.querySelectorAll('.film-item.cur').forEach(e => e.classList.remove('cur'));
  const cur = film.track.querySelector(`.film-item[data-i="${idx}"]`);
  if (cur) cur.classList.add('cur');
  film.programmatic = true;
  film.el.scrollTo({ left: (idx - film.start) * film.pitch, behavior: viewerOpen() && !reducedMotion() ? 'smooth' : 'auto' });
  clearTimeout(film.pt);
  film.pt = setTimeout(() => { film.programmatic = false; }, 450);
}
film.el.addEventListener('scroll', () => {
  if (film.programmatic) return;
  const i = clamp(film.start + Math.round(film.el.scrollLeft / film.pitch), film.start, film.end);
  if (i !== film.center) {
    film.center = i;
    film.track.querySelectorAll('.film-item.cur').forEach(e => e.classList.remove('cur'));
    const cur = film.track.querySelector(`.film-item[data-i="${i}"]`);
    if (cur) cur.classList.add('cur');
    const it = state.lightboxItems[i];
    if (it && it.kind !== 'video') lbImg.src = thumbUrl(it.id);       // live scrub preview
  }
  clearTimeout(film.timer);
  film.timer = setTimeout(() => { if (film.center !== state.lightboxIdx) openLightbox(film.center, { fromFilm: true }); }, 140);
}, { passive: true });
film.el.addEventListener('click', (e) => {
  const it = e.target.closest('.film-item');
  if (it) openLightbox(+it.dataset.i);
});

// ── Zoom (wheel, double-tap, pinch, pan) ──────────────────────────────────
const lbZoom = { scale: 1, tx: 0, ty: 0 };
let lbZoomMoved = false;
function applyLbZoom() {
  lbImg.style.transform = lbZoom.scale === 1 && !lbZoom.tx && !lbZoom.ty ? '' : `translate(${lbZoom.tx}px, ${lbZoom.ty}px) scale(${lbZoom.scale})`;
  lb.classList.toggle('zoomed', lbZoom.scale > 1);
}
function resetLightboxZoom() {
  lbZoom.scale = 1; lbZoom.tx = 0; lbZoom.ty = 0;
  lbImg.style.transition = ''; lbImg.style.transform = '';
  lb.classList.remove('zoomed');
}
function clampLbPan() {
  const rect = lbStage.getBoundingClientRect();
  const maxX = (lbZoom.scale - 1) * rect.width / 2, maxY = (lbZoom.scale - 1) * rect.height / 2;
  lbZoom.tx = clamp(lbZoom.tx, -maxX, maxX);
  lbZoom.ty = clamp(lbZoom.ty, -maxY, maxY);
}
function lbZoomTo(newScale, ox, oy) {
  newScale = clamp(newScale, 1, 6);
  const rect = lbStage.getBoundingClientRect();
  const cx = ox - rect.left - rect.width / 2, cy = oy - rect.top - rect.height / 2;
  const ratio = newScale / lbZoom.scale;
  lbZoom.tx = cx - (cx - lbZoom.tx) * ratio;
  lbZoom.ty = cy - (cy - lbZoom.ty) * ratio;
  lbZoom.scale = newScale;
  if (lbZoom.scale === 1) { lbZoom.tx = 0; lbZoom.ty = 0; }
  clampLbPan();
  applyLbZoom();
}
const lbIsImage = () => { const it = currentItem(); return it && it.kind !== 'video'; };
function toggleChrome() { lb.classList.toggle('chrome-hidden'); }

lbStage.addEventListener('wheel', (e) => {
  if (!viewerOpen() || !lbIsImage()) return;
  e.preventDefault();
  lbImg.style.transition = 'transform 0.08s ease-out';
  lbZoomTo(lbZoom.scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18), e.clientX, e.clientY);
}, { passive: false });

// Mouse: click toggles chrome (delayed so a double-click can zoom instead).
let lbClickTimer = null, lastTouchAt = 0;
lbStage.addEventListener('click', (e) => {
  if (performance.now() - lastTouchAt < 600) return;        // touch handled below
  if (e.target !== lbImg && e.target !== lbStage && e.target !== lbVid) return;
  if (e.target === lbVid && lb.classList.contains('is-video')) return;
  if (lbZoomMoved) { lbZoomMoved = false; return; }
  if (lbClickTimer) { clearTimeout(lbClickTimer); lbClickTimer = null; return; }
  lbClickTimer = setTimeout(() => { lbClickTimer = null; if (lbZoom.scale === 1) toggleChrome(); }, 250);
});
lbStage.addEventListener('dblclick', (e) => {
  // Touch double-taps are handled in touchGestures; browsers ALSO synthesise a
  // dblclick from them, which would zoom straight back out.
  if (performance.now() - lastTouchAt < 700) { e.preventDefault(); return; }
  if (!lbIsImage()) return;
  e.preventDefault();
  lbImg.style.transition = 'transform 0.2s ease-out';
  if (lbZoom.scale > 1) resetLightboxZoom(); else lbZoomTo(2.5, e.clientX, e.clientY);
});
// Pan while zoomed (mouse + single touch).
(function () {
  let dragging = false, lastX = 0, lastY = 0;
  lbImg.addEventListener('pointerdown', (e) => {
    if (lbZoom.scale <= 1) return;
    dragging = true; lbZoomMoved = false; lastX = e.clientX; lastY = e.clientY;
    try { lbImg.setPointerCapture(e.pointerId); } catch (_) {}
    lbImg.style.transition = 'none';
  });
  lbImg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) lbZoomMoved = true;
    lastX = e.clientX; lastY = e.clientY;
    lbZoom.tx += dx; lbZoom.ty += dy;
    clampLbPan(); applyLbZoom();
  });
  const end = () => { dragging = false; };
  lbImg.addEventListener('pointerup', end);
  lbImg.addEventListener('pointercancel', end);
})();

// ── Touch gestures ────────────────────────────────────────────────────────
(function touchGestures() {
  let g = null;              // current one-finger gesture
  let pinch = 0, pinchCX = 0, pinchCY = 0;
  let lastTap = null, tapTimer = null;
  const W = () => window.innerWidth, H = () => window.innerHeight;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  // Touches on a video's own control bar belong to the video.
  const onVideoControls = (t) => {
    if (!lb.classList.contains('is-video')) return false;
    const r = lbVid.getBoundingClientRect();
    return t.clientY > r.bottom - 70 && t.clientY < r.bottom + 10;
  };

  lbStage.addEventListener('touchstart', (e) => {
    lastTouchAt = performance.now();
    if (e.touches.length === 2) {
      if (g && g.holdTimer) clearTimeout(g.holdTimer);
      g = null;
      if (lbIsImage()) {
        pinch = dist(e.touches);
        pinchCX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        pinchCY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      }
      return;
    }
    if (e.touches.length !== 1) { g = null; return; }
    const t = e.touches[0];
    if (onVideoControls(t)) { g = null; return; }
    // While zoomed, one finger pans (pointer handlers on the image); we only
    // watch for a stationary double-tap to zoom back out.
    g = { x: t.clientX, y: t.clientY, t0: performance.now(), axis: null, dx: 0, dy: 0, zoomed: lbZoom.scale > 1 };
    if (g.zoomed) return;
    // Press-and-hold plays a Live Photo.
    const item = currentItem();
    if (item && item.kind === 'photo' && item.live_video_id && !lb.classList.contains('info-open')) {
      g.holdTimer = setTimeout(() => { if (g && !g.axis) { g.holding = true; playLive({ hold: true }); } }, 380);
    }
  }, { passive: true });

  lbStage.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinch > 0) {
      e.preventDefault();
      lbImg.style.transition = 'none';
      const d = dist(e.touches);
      lbZoomTo(lbZoom.scale * (d / pinch), pinchCX, pinchCY);
      pinch = d;
      return;
    }
    if (!g || e.touches.length !== 1) return;
    const t = e.touches[0];
    g.dx = t.clientX - g.x; g.dy = t.clientY - g.y;
    if (g.zoomed) return;
    if (!g.axis) {
      if (Math.hypot(g.dx, g.dy) < 10) return;
      if (g.holdTimer) clearTimeout(g.holdTimer);
      if (g.holding) return;                              // keep playing; ignore drift
      const horiz = Math.abs(g.dx) > Math.abs(g.dy);
      if (lb.classList.contains('info-open')) g.axis = horiz ? 'x' : (g.dy > 0 ? 'info-down' : 'none');
      else g.axis = horiz ? 'x' : (g.dy > 0 ? 'down' : 'up');
      if (g.axis === 'x') lbImg.style.transition = 'none';
      if (g.axis === 'down') { lbStage.classList.add('no-anim'); lb.classList.add('dragging'); }
    }
    e.preventDefault();
    if (g.axis === 'x') {
      const atEdge = (g.dx > 0 && state.lightboxIdx === 0) || (g.dx < 0 && state.lightboxIdx >= state.lightboxItems.length - 1);
      lbImg.style.transform = `translateX(${atEdge ? g.dx * 0.3 : g.dx}px)`;
    } else if (g.axis === 'down') {
      const p = clamp(g.dy / H(), 0, 1);
      lbStage.style.transform = `translate(${g.dx * 0.7}px, ${g.dy}px) scale(${1 - p * 0.45})`;
      lbBg.style.opacity = String(clamp(1 - g.dy / (H() * 0.55), 0, 1));
    } else if (g.axis === 'up') {
      lbStage.classList.add('no-anim');
      lbStage.style.transform = `translateY(${Math.max(g.dy, -120) * 0.35}px)`;
    }
  }, { passive: false });

  const end = (e) => {
    if (e.touches && e.touches.length) return;
    lastTouchAt = performance.now();
    if (pinch) { pinch = 0; if (lbZoom.scale <= 1.02) resetLightboxZoom(); return; }
    const gg = g; g = null;
    if (!gg) return;
    if (gg.holdTimer) clearTimeout(gg.holdTimer);
    if (gg.holding) { stopLive(); return; }
    if (gg.zoomed && Math.hypot(gg.dx, gg.dy) > 10) return;          // that was a pan
    const dt = Math.max(1, performance.now() - gg.t0);
    if (gg.axis === 'x') {
      lbImg.style.transition = '';
      const fast = Math.abs(gg.dx) / dt > 0.45;
      if ((Math.abs(gg.dx) > W() * 0.22 || fast) && lightboxNav(gg.dx < 0 ? 1 : -1)) return;
      lbImg.style.transform = '';
      return;
    }
    if (gg.axis === 'down') {
      lb.classList.remove('dragging');
      lbStage.classList.remove('no-anim');
      if (gg.dy > 110 || gg.dy / dt > 0.5) { closeLightbox(); return; }
      lbStage.style.transform = '';
      lbBg.style.transition = 'opacity 0.25s'; lbBg.style.opacity = '1';
      setTimeout(() => { lbBg.style.transition = ''; lbBg.style.opacity = ''; }, 260);
      return;
    }
    if (gg.axis === 'up') {
      lbStage.classList.remove('no-anim');
      lbStage.style.transform = '';
      if (-gg.dy > 50) openMetaPanel();
      return;
    }
    if (gg.axis === 'info-down') { if (gg.dy > 60) closeMetaPanel(); return; }
    if (gg.axis) return;
    // A tap: second tap within 300ms → zoom; otherwise toggle the chrome.
    const now = performance.now();
    if (lastTap && now - lastTap.t < 300 && Math.hypot(gg.x - lastTap.x, gg.y - lastTap.y) < 40) {
      clearTimeout(tapTimer); tapTimer = null; lastTap = null;
      if (lbIsImage()) {
        lbImg.style.transition = 'transform 0.22s ease-out';
        if (lbZoom.scale > 1) resetLightboxZoom(); else lbZoomTo(2.5, gg.x, gg.y);
      }
      return;
    }
    lastTap = { t: now, x: gg.x, y: gg.y };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      tapTimer = null;
      if (lb.classList.contains('info-open')) { closeMetaPanel(); return; }
      if (lbZoom.scale === 1 && !lb.classList.contains('is-video')) toggleChrome();
      else if (lb.classList.contains('is-video')) toggleChrome();
    }, 260);
  };
  lbStage.addEventListener('touchend', end, { passive: true });
  lbStage.addEventListener('touchcancel', end, { passive: true });
})();

// Keyboard (ignored while typing in a field).
document.addEventListener('keydown', (e) => {
  if (!viewerOpen()) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (document.querySelector('.menu') || openSheets.length) return;
  if (e.key === 'Escape') { if ($('metaPanel').classList.contains('open')) closeMetaPanel(); else closeLightbox(); }
  else if (e.key === 'ArrowRight') lightboxNav(1);
  else if (e.key === 'ArrowLeft') lightboxNav(-1);
  else if (e.key === 'f' || e.key === 'F') toggleLightboxFit();
  else if (e.key === 'i' || e.key === 'I') toggleMetaPanel();
  else if (e.key === ' ' && currentItem() && currentItem().live_video_id) { e.preventDefault(); playLive(); }
});

// Video: fade our chrome shortly after playback starts, bring it back on pause.
(function () {
  let hideT = null;
  lbVid.addEventListener('play', () => {
    if (lbVid.classList.contains('live-overlay')) return;
    clearTimeout(hideT);
    hideT = setTimeout(() => { if (!lbVid.paused) lb.classList.add('chrome-hidden'); }, 1600);
  });
  const reveal = () => { clearTimeout(hideT); if (!lbVid.classList.contains('live-overlay')) lb.classList.remove('chrome-hidden'); };
  lbVid.addEventListener('pause', reveal);
  lbVid.addEventListener('ended', reveal);
})();

// ── Info sheet ────────────────────────────────────────────────────────────
const metaPanel = $('metaPanel');
function toggleMetaPanel() { if (metaPanel.classList.contains('open')) closeMetaPanel(); else openMetaPanel(); }
function openMetaPanel() {
  const item = currentItem();
  if (!item) return;
  resetLightboxZoom();
  metaPanel.classList.add('open');
  metaPanel.classList.remove('full');
  lb.classList.add('info-open');
  lb.classList.remove('chrome-hidden');
  $('lbInfoBtn').classList.add('on');
  loadMetaPanel(item.id);
  if (!isPhone()) setTimeout(() => renderFilm(state.lightboxIdx), 320);
}
function closeMetaPanel(instant) {
  metaPanel.classList.remove('open', 'full');
  lb.classList.remove('info-open');
  const b = $('lbInfoBtn'); if (b) b.classList.remove('on');
  if (instant) { lbStage.classList.add('no-anim'); requestAnimationFrame(() => lbStage.classList.remove('no-anim')); }
  else if (!isPhone() && viewerOpen()) setTimeout(() => renderFilm(state.lightboxIdx), 320);
}
// Long-press "Info" from a grid opens the viewer on that item with Info up.
function openInfoForItem(item, grid, idx) {
  if (grid) openLightboxFromGrid(grid, idx); else openLightboxWith([item], 0);
  setTimeout(openMetaPanel, 80);
}
// Drag the sheet's grabber: up → full height, down → half / close.
(function () {
  const grab = $('infoGrab');
  let y0 = 0, dy = 0, on = false;
  grab.addEventListener('pointerdown', (e) => { on = true; y0 = e.clientY; dy = 0; metaPanel.classList.add('dragging'); try { grab.setPointerCapture(e.pointerId); } catch (_) {} });
  grab.addEventListener('pointermove', (e) => { if (!on) return; dy = e.clientY - y0; metaPanel.style.transform = dy > 0 ? `translateY(${dy}px)` : ''; });
  const up = () => {
    if (!on) return;
    on = false; metaPanel.classList.remove('dragging'); metaPanel.style.transform = '';
    if (dy < -40) metaPanel.classList.add('full');
    else if (dy > 80) { if (metaPanel.classList.contains('full')) metaPanel.classList.remove('full'); else closeMetaPanel(); }
  };
  grab.addEventListener('pointerup', up);
  grab.addEventListener('pointercancel', up);
  // Scrolling the body up while at half height expands the sheet.
  $('metaPanelBody').addEventListener('scroll', (e) => {
    if (e.target.scrollTop > 30 && isPhone()) metaPanel.classList.add('full');
  }, { passive: true });
})();

async function loadMetaPanel(id) {
  const body = $('metaPanelBody');
  state.metaAssetId = id;
  if (!assetCache.has(id)) body.innerHTML = '<div class="info-loading"><span class="spinner"></span></div>';
  try {
    const a = await getAssetDetails(id);
    if (state.metaAssetId !== id) return;
    renderInfo(a);
  } catch (_) {
    if (state.metaAssetId === id) body.innerHTML = '<p class="group-foot">Couldn’t load the details for this item.</p>';
  }
}

function renderInfo(a) {
  const body = $('metaPanelBody');
  const ext = a.path ? a.path.split('.').pop().toUpperCase() : '';
  const mp = a.width && a.height ? Math.round((a.width * a.height) / 1e5) / 10 : null;
  const live = a.live_video_id ? ' · Live Photo' : '';
  const kindLine = a.kind === 'video' ? `Video${a.duration_s ? ' · ' + fmtDuration(a.duration_s) : ''}` : (a.taken_at ? fmtTime(a.taken_at) : '') + live;
  const place = [a.place_name, a.place_country].filter(Boolean).join(', ');
  let h = '';
  if (a.caption) {
    // Some caption styles end with "Keywords: a, b, c" — show those quieter.
    const m = String(a.caption).split(/\s*\bKeywords?\s*:\s*/i);
    const text = m[0].trim(), keywords = (m[1] || '').trim().replace(/\.$/, '');
    h += `<div class="info-caption-label">${ic('sparkle')}Description</div>
      <div class="info-caption${text.length > 140 ? ' long' : ''}">${escapeHtml(text)}</div>
      ${keywords ? `<div class="info-keywords">${escapeHtml(keywords)}</div>` : ''}`;
  }
  h += `<div class="info-when">${ic('cal')}<div><b>${escapeHtml(a.taken_at ? fmtDateLong(a.taken_at) : 'Unknown date')}</b><span>${escapeHtml(kindLine.replace(/^ · /, ''))}</span></div></div>`;
  if (a.gps_lat != null && a.gps_lon != null) {
    h += `<button type="button" class="info-map" id="infoMap" aria-label="Show on map">
      <span class="pin"></span><span class="map-chip">${ic('places')}<span>${escapeHtml(place || `${a.gps_lat.toFixed(3)}, ${a.gps_lon.toFixed(3)}`)}</span></span></button>`;
  } else if (place) {
    h += `<p class="info-place-text">${escapeHtml(place)}</p>`;
  }
  h += `<div class="info-section-title">Tags</div><div class="info-tags" id="metaTags"></div>
        <div class="tag-add-row" id="metaTagAddRow" hidden>
          <input id="metaTagInput" placeholder="Tag name" autocomplete="off" spellcheck="false" maxlength="80" enterkeyhint="done">
          <button type="button" class="btn small" id="metaTagAddBtn">Add</button>
        </div>
        <div id="metaTagSuggest"></div>`;
  const camLine = [a.lens, mp ? mp + ' MP' : null, a.width && a.height ? `${a.width} × ${a.height}` : null].filter(Boolean).join(' · ');
  h += `<div class="info-card">
      <div class="info-card-head"><b>${escapeHtml(a.camera || (a.kind === 'video' ? 'Video' : 'Unknown camera'))}</b>${ext ? `<span class="fmt-badge">${escapeHtml(ext)}</span>` : ''}</div>
      ${camLine ? `<p>${escapeHtml(camLine)}</p>` : ''}
      <p>${escapeHtml([fmtBytes(a.bytes), a.duration_s ? fmtDuration(a.duration_s) : null].filter(Boolean).join(' · '))}</p>
    </div>`;
  h += `<details class="info-details"><summary>File details ${ic('chev')}</summary>
      <dl>
        <div class="info-kv"><dt>Name</dt><dd class="mono">${escapeHtml(a.filename || '')}</dd></div>
        <div class="info-kv"><dt>Location on disk</dt><dd class="mono">${escapeHtml(a.path || '')}</dd></div>
        ${a.gps_lat != null ? `<div class="info-kv"><dt>Coordinates</dt><dd class="mono">${a.gps_lat.toFixed(5)}, ${a.gps_lon.toFixed(5)}</dd></div>` : ''}
        <div class="info-kv"><dt>Captured</dt><dd>${escapeHtml(a.taken_at ? new Date(a.taken_at).toLocaleString('en-GB') : 'Unknown')}</dd></div>
      </dl></details>`;
  const actions = [];
  if (havePerm('photos.hidden')) actions.push(`<button type="button" class="row" id="metaPrivBtn">${ic(a.hidden ? 'unlock' : 'lock')}<span class="row-label">${a.hidden ? 'Unhide' : 'Hide'}</span></button>`);
  if (havePerm('photos.delete')) actions.push(a.removed
    ? `<button type="button" class="row" id="metaRestoreBtn">${ic('restore')}<span class="row-label">Restore to library</span></button>`
    : `<button type="button" class="row danger" id="metaRemoveBtn">${ic('trash')}<span class="row-label">Remove from library</span></button>`);
  if (actions.length) h += `<div class="info-actions"><div class="group">${actions.join('')}</div></div>`;
  body.innerHTML = h;

  const map = $('infoMap');
  if (map) {
    renderMiniMap(map, a.gps_lat, a.gps_lon);
    map.addEventListener('click', () => { closeLightbox(true); openPlacesAt(a.gps_lat, a.gps_lon, a.place_id); });
  }
  const priv = $('metaPrivBtn');
  if (priv) priv.addEventListener('click', () => {
    if (a.hidden && !state.privateUnlocked) showPasscodeModal('Enter your passcode to unhide this photo', () => togglePrivatePhoto(a.id, true));
    else togglePrivatePhoto(a.id, !!a.hidden);
  });
  const rm = $('metaRemoveBtn'); if (rm) rm.addEventListener('click', () => removeAssetFromLibrary(a.id));
  const rs = $('metaRestoreBtn'); if (rs) rs.addEventListener('click', () => restoreRemoved(a.id));
  renderMetaTags(a.tags || []);
  const input = $('metaTagInput');
  $('metaTagAddBtn').addEventListener('click', metaAddTag);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); metaAddTag(); } });
}

function renderMiniMap(host, lat, lon) {
  ensureWorldPaths().then((paths) => {
    if (!host.isConnected || !paths) return;
    let svg = renderMiniMap.svg;
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      svg.innerHTML = paths.map(d => `<path d="${d}"/>`).join('');
      renderMiniMap.svg = svg;
    }
    const [x, y] = projectLonLat(lon, lat);
    const w = 22, hgt = w * (host.clientHeight || 108) / (host.clientWidth || 360);
    svg.setAttribute('viewBox', `${x - w / 2} ${y - hgt / 2} ${w} ${hgt}`);
    host.insertBefore(svg, host.firstChild);
  });
}

function renderMetaTags(tags) {
  const el = $('metaTags');
  if (!el) return;
  const canTag = havePerm('photos.tag');
  el.innerHTML = tags.map(t => `<span class="chip" data-tag="${t.id}"><span class="tag-name">${escapeHtml(t.name)}</span>${canTag ? `<button type="button" class="tag-x" aria-label="Remove tag">${ic('x')}</button>` : ''}</span>`).join('')
    + (canTag ? `<button type="button" class="chip dashed add" id="metaTagAddChip">${ic('plus', 'sm')}Tag</button>` : '')
    + (!tags.length && !canTag ? '<span class="group-foot" style="padding:0">No tags</span>' : '');
  el.querySelectorAll('[data-tag]').forEach((chip) => {
    const id = +chip.dataset.tag, name = chip.querySelector('.tag-name').textContent;
    chip.querySelector('.tag-name').addEventListener('click', () => { closeLightbox(true); openTagDetail({ id, name }); });
    const x = chip.querySelector('.tag-x');
    if (x) x.addEventListener('click', (e) => { e.stopPropagation(); metaRemoveTag(id); });
  });
  const add = $('metaTagAddChip');
  if (add) add.addEventListener('click', showTagInput);
}
function showTagInput() {
  const row = $('metaTagAddRow');
  if (!row) return;
  row.hidden = false;
  const input = $('metaTagInput');
  input.focus();
}
async function metaAddTag() {
  const input = $('metaTagInput');
  const name = (input.value || '').trim();
  const id = state.metaAssetId;
  if (!name || !id) return;
  const done = btnBusy($('metaTagAddBtn'), 'Adding');
  try {
    const r = await postJSON('/api/aurora/tags/apply', { name, assetIds: [id] });
    input.value = '';
    done();
    const a = await getAssetDetails(id, true);
    if (state.metaAssetId === id) renderMetaTags(a.tags || []);
    checkSmartSuggestion(r.tagId, r.name);
  } catch (e) { toast('Couldn’t add the tag: ' + e.message); done(); }
}
async function metaRemoveTag(tagId) {
  const id = state.metaAssetId;
  if (!id) return;
  try {
    await postJSON('/api/aurora/tags/remove', { tagId, assetIds: [id] });
    const a = await getAssetDetails(id, true);
    if (state.metaAssetId === id) renderMetaTags(a.tags || []);
    dismissSuggestion();
  } catch (_) { toast('Couldn’t remove the tag'); }
}
// After tagging one photo, offer to tag the rest of that trip.
async function checkSmartSuggestion(tagId, name) {
  const box = $('metaTagSuggest');
  if (!box || !tagId) return;
  box.innerHTML = '';
  try {
    const s = await getJSON(`/api/aurora/tags/${tagId}/suggest` + (state.hideRaw ? '?hideRaw=1' : ''));
    if (!s.total || !s.window || !$('metaTagSuggest')) return;
    const where = s.country ? ` in <b>${escapeHtml(s.country)}</b>` : '';
    box.innerHTML = `<div class="tag-suggest">
        <b>${s.total.toLocaleString()}</b> more ${s.total === 1 ? 'photo' : 'photos'} from <b>${fmtDate(s.window.from)} – ${fmtDate(s.window.to)}</b>${where} look like “${escapeHtml(name)}”.
        <div class="btn-row"><button type="button" class="btn small" id="suggestAddBtn">Tag all ${s.total.toLocaleString()}</button>
        <button type="button" class="btn small gray" onclick="dismissSuggestion()">Not now</button></div></div>`;
    $('suggestAddBtn').addEventListener('click', () => applySmartSuggestion(tagId, name));
  } catch (_) {}
}
async function applySmartSuggestion(tagId, name) {
  const done = btnBusy($('suggestAddBtn'), 'Tagging');
  try {
    const r = await postJSON(`/api/aurora/tags/${tagId}/apply-suggestion`, { hideRaw: state.hideRaw });
    dismissSuggestion();
    toast(`Tagged ${(r.added || 0).toLocaleString()} more photos “${name}”`);
    if (state.metaAssetId) { const a = await getAssetDetails(state.metaAssetId, true); renderMetaTags(a.tags || []); }
  } catch (_) { toast('Couldn’t tag the trip'); done(); }
}
function dismissSuggestion() { const b = $('metaTagSuggest'); if (b) b.innerHTML = ''; }
