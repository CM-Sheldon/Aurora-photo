/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — grid.js
   VirtualGrid: the one photo grid used everywhere (Library, Search, every
   collection, places). Only tiles near the viewport exist in the DOM, so a
   grid of 200,000 items scrolls like one of 200.

   Features: shared zoom level (pinch on touch, ctrl/⌘+wheel on desktop),
   tap → viewer, long-press / right-click → context menu, select mode with
   iOS-style swipe-to-select (horizontal drag sweeps, vertical drag scrolls),
   auto-scroll at the edges while sweeping, paging hook (onNearEnd), and the
   tile rect the viewer zooms back into.
   ════════════════════════════════════════════════════════════════════════ */

// ── Shared zoom level ("one grid everywhere") ─────────────────────────────
const GRID_ZOOM = {
  phoneCols: [3, 4, 5, 7],          // columns on phone-width grids
  desktopTile: [300, 220, 160, 112], // target tile size (px) on wider grids
  level: (() => { try { const v = parseInt(localStorage.getItem('aurora.gridZoom'), 10); return v >= 0 && v <= 3 ? v : 1; } catch (_) { return 1; } })(),
};
const allGrids = new Set();
function gridColsFor(width) {
  if (width <= 760) return GRID_ZOOM.phoneCols[GRID_ZOOM.level];
  return Math.max(2, Math.round(width / GRID_ZOOM.desktopTile[GRID_ZOOM.level]));
}
// level: 0 = biggest tiles … 3 = smallest. `anchor` keeps one item still on screen.
function setGridZoom(level, anchor) {
  level = clamp(level, 0, GRID_ZOOM.phoneCols.length - 1);
  if (level === GRID_ZOOM.level) return false;
  GRID_ZOOM.level = level;
  try { localStorage.setItem('aurora.gridZoom', String(level)); } catch (_) {}
  allGrids.forEach(g => { if (g.isShown()) g.relayout(anchor && anchor.grid === g ? anchor : null); else g.dirty = true; });
  return true;
}

class VirtualGrid {
  // opts: el, scroller, padTop(), padBottom(), onScroll(grid), onNearEnd(grid),
  //       onTap(idx, item) → true to swallow, contextItems(item, idx), name
  constructor(opts) {
    this.opts = opts;
    this.el = opts.el;
    this.scroller = opts.scroller;
    this.gap = opts.gap != null ? opts.gap : 2;
    this.items = [];
    this.cols = 4; this.cellW = 0; this.rowH = 0; this.rows = 0;
    this.padTop = 0; this.padBottom = 0; this.offset = 0;
    this.rendered = new Map();
    this.hasMore = false;
    this.loadingMore = false;
    this.dirty = false;
    this.lastTop = 0; this.raf = false;
    this.scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.bindPointer();
    this.bindPinch();
    this.bindHoverPreview();
    allGrids.add(this);
  }

  isShown() { return this.el.isConnected && this.el.getClientRects().length > 0; }

  // ── Data ─────────────────────────────────────────────────────────────
  setItems(items, opts = {}) {
    this.items = items || [];
    this.clear();
    this.layout();
    if (!opts.keepScroll) this.scroller.scrollTop = 0;
    this.paint();
  }
  appendItems(more) {
    if (!more || !more.length) return;
    for (const it of more) this.items.push(it);
    this.layout();
    this.paint();
  }
  clear() { this.el.textContent = ''; this.rendered.clear(); }

  // ── Geometry ─────────────────────────────────────────────────────────
  layout() {
    const w = this.el.clientWidth;
    if (!w) return false;               // hidden — re-run when shown
    this.dirty = false;
    this.cols = gridColsFor(w);
    this.cellW = (w - (this.cols - 1) * this.gap) / this.cols;
    this.rowH = this.cellW + this.gap;
    this.padTop = this.opts.padTop ? this.opts.padTop() : 0;
    this.padBottom = this.opts.padBottom ? this.opts.padBottom() : 0;
    this.rows = Math.ceil(this.items.length / this.cols);
    this.el.style.height = (this.rows ? this.padTop + this.rows * this.rowH - this.gap + this.padBottom : 0) + 'px';
    this.measureOffset();
    return true;
  }
  measureOffset() {
    this.offset = this.el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
  }
  // Re-flow after a width / zoom change, keeping an anchor item where it was.
  relayout(anchor) {
    if (!this.items.length) { this.layout(); return; }
    let idx, screenY;
    if (anchor && anchor.idx >= 0) { idx = anchor.idx; screenY = anchor.screenY; }
    else if (this.cellW) {
      idx = this.indexAtContentY(this.scroller.scrollTop + this.padTop + 1);
      screenY = this.contentY(idx) - this.scroller.scrollTop;
    }
    this.clear();
    if (!this.layout()) return;
    if (idx != null && idx >= 0 && idx < this.items.length) {
      this.scroller.scrollTop = Math.max(0, this.contentY(idx) - screenY);
    }
    this.paint();
  }
  rowOf(idx) { return Math.floor(idx / this.cols); }
  // y of an item's row inside the scroller's content
  contentY(idx) { return this.offset + this.padTop + this.rowOf(idx) * this.rowH; }
  indexAtContentY(y) {
    const r = clamp(Math.floor((y - this.offset - this.padTop) / Math.max(1, this.rowH)), 0, Math.max(0, this.rows - 1));
    return Math.min(this.items.length - 1, r * this.cols);
  }
  // Item index under a viewport point, or -1.
  indexAtPoint(clientX, clientY) {
    const r = this.el.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top - this.padTop;
    if (x < 0 || y < 0 || x > r.width) return -1;
    const row = Math.floor(y / this.rowH), col = Math.min(this.cols - 1, Math.floor(x / (this.cellW + this.gap)));
    const idx = row * this.cols + col;
    return idx >= 0 && idx < this.items.length ? idx : -1;
  }
  tileBox(idx) {
    const c = idx % this.cols, r = this.rowOf(idx);
    const x0 = Math.round(c * (this.cellW + this.gap)), x1 = Math.round((c + 1) * (this.cellW + this.gap) - this.gap);
    const y0 = Math.round(this.padTop + r * this.rowH), y1 = Math.round(this.padTop + r * this.rowH + this.cellW);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  // Viewport rect of a tile (for the viewer's zoom in/out), or null if off screen.
  tileRect(idx) {
    if (idx < 0 || idx >= this.items.length || !this.isShown()) return null;
    const b = this.tileBox(idx), er = this.el.getBoundingClientRect(), sr = this.scroller.getBoundingClientRect();
    const rect = { left: er.left + b.x, top: er.top + b.y, width: b.w, height: b.h };
    if (rect.top + rect.height < sr.top || rect.top > sr.bottom) return null;
    return rect;
  }
  tileEl(idx) { return this.rendered.get(idx) || null; }
  ensureVisible(idx) {
    if (idx < 0 || idx >= this.items.length || !this.cellW) return;
    const y = this.contentY(idx), st = this.scroller.scrollTop, vh = this.scroller.clientHeight;
    if (y < st + this.padTop || y + this.cellW > st + vh - 120) {
      this.scroller.scrollTop = Math.max(0, y - (vh - this.cellW) / 2);
      this.paint();
    }
  }
  scrollToIndex(idx, align) {
    if (!this.cellW) this.layout();
    const y = this.contentY(clamp(idx, 0, this.items.length - 1));
    this.scroller.scrollTop = align === 'center' ? Math.max(0, y - this.scroller.clientHeight / 2) : Math.max(0, y - this.padTop);
    this.paint();
  }

  // ── Painting ─────────────────────────────────────────────────────────
  schedule() {
    if (this.raf) return;
    this.raf = true;
    requestAnimationFrame(() => {
      this.raf = false;
      if (!this.isShown()) return;
      if (this.dirty) this.relayout();
      this.paint();
      if (this.opts.onScroll) this.opts.onScroll(this);
    });
  }
  paint() {
    if (!this.items.length || !this.cellW) return;
    const st = this.scroller.scrollTop, vh = this.scroller.clientHeight || window.innerHeight;
    const dir = st >= this.lastTop ? 1 : -1;
    this.lastTop = st;
    const ahead = vh * 1.5, behind = vh * 0.6;
    const base = st - this.offset - this.padTop;
    const r0 = Math.max(0, Math.floor((base - (dir > 0 ? behind : ahead)) / this.rowH));
    const r1 = Math.min(this.rows - 1, Math.floor((base + vh + (dir > 0 ? ahead : behind)) / this.rowH));
    const want = new Set();
    const frag = document.createDocumentFragment();
    for (let r = r0; r <= r1; r++) {
      for (let c = 0; c < this.cols; c++) {
        const idx = r * this.cols + c;
        if (idx >= this.items.length) break;
        want.add(idx);
        if (!this.rendered.has(idx)) {
          const t = this.makeTile(idx);
          frag.appendChild(t);
          this.rendered.set(idx, t);
        }
      }
    }
    if (frag.childNodes.length) this.el.appendChild(frag);
    for (const [idx, el] of this.rendered) if (!want.has(idx)) { el.remove(); this.rendered.delete(idx); }
    if (this.opts.onNearEnd && this.hasMore && !this.loadingMore && r1 >= this.rows - 4) {
      this.loadingMore = true;
      Promise.resolve(this.opts.onNearEnd(this)).finally(() => { this.loadingMore = false; });
    }
  }
  makeTile(idx) {
    const item = this.items[idx];
    const b = this.tileBox(idx);
    const t = document.createElement('div');
    t.className = 'tile' + (state.selected.has(item.id) ? ' selected' : '');
    t.dataset.idx = idx;
    t.dataset.id = item.id;
    t.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
    t.innerHTML = this.tileInner(item);
    return t;
  }
  tileInner(item) {
    let h = `<img decoding="async" alt="" draggable="false" src="${thumbUrl(item.id)}">`;
    if (item.kind === 'video') {
      const d = fmtDuration(item.duration_s != null ? item.duration_s : item.d);
      h += `<span class="t-dur">${d || ic('play', 'sm')}</span>`;
    }
    if (item.fav) h += `<span class="t-fav">${ic('heart-fill')}</span>`;
    if (canHover() && havePerm('photos.favorite')) h += `<button type="button" class="t-favbtn" aria-label="Favourite">${ic(item.fav ? 'heart-fill' : 'heart')}</button>`;
    h += `<span class="t-check">${ic('check')}</span>`;
    return h;
  }
  updateItem(idx) {
    const t = this.rendered.get(idx);
    if (!t) return;
    t.innerHTML = this.tileInner(this.items[idx]);
    t.classList.toggle('selected', state.selected.has(this.items[idx].id));
  }
  updateById(id) {
    for (const [idx, t] of this.rendered) if (this.items[idx] && this.items[idx].id === id) this.updateItem(idx);
  }
  refreshSelection() {
    for (const [idx, t] of this.rendered) t.classList.toggle('selected', !!this.items[idx] && state.selected.has(this.items[idx].id));
  }
  removeIds(ids) {
    const set = new Set(ids);
    const before = this.items.length;
    this.items = this.items.filter(it => !set.has(it.id));
    if (this.items.length !== before) this.relayout();
  }

  // ── Interaction ──────────────────────────────────────────────────────
  bindPointer() {
    const el = this.el;
    let lp = null;   // long-press tracker
    let lastLpAt = 0; // when our long-press menu last opened (Android also fires contextmenu)
    let suppressClick = false;

    el.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile) return;
      if (suppressClick) { suppressClick = false; return; }
      const idx = +tile.dataset.idx, item = this.items[idx];
      if (!item) return;
      if (e.target.closest('.t-favbtn')) { e.stopPropagation(); toggleFavItem(item, this); return; }
      if (state.selectMode) return;            // handled by the select pointer logic
      if (this.opts.onTap && this.opts.onTap(idx, item, tile) === true) return;
      openLightboxFromGrid(this, idx);
    });

    el.addEventListener('contextmenu', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile || state.selectMode) return;
      e.preventDefault();
      if (performance.now() - lastLpAt < 1500) return;   // already open from the long-press
      this.openContextMenu(+tile.dataset.idx, tile);
    });

    // Long-press = one finger held still for 480ms. A second finger (pinch) or
    // any movement cancels it, and a stale press never swallows a later tap.
    const touches = new Set();
    el.addEventListener('pointerdown', (e) => {
      suppressClick = false;
      const tile = e.target.closest('.tile');
      if (!tile || e.button > 0) return;
      const idx = +tile.dataset.idx;
      if (state.selectMode && state.selectGrid === this) { this.selectPointerDown(e, idx); return; }
      if (e.pointerType !== 'touch') return;
      touches.add(e.pointerId);
      if (lp) { clearTimeout(lp.timer); lp = null; }
      if (touches.size > 1) return;
      lp = { x: e.clientX, y: e.clientY, idx, tile, pid: e.pointerId, timer: setTimeout(() => {
        lp = null;
        if (touches.size !== 1) return;
        suppressClick = true;
        lastLpAt = performance.now();
        if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) {} }
        this.openContextMenu(idx, tile);
      }, 480) };
    });
    const cancelLp = (e) => {
      if (e && (e.type === 'pointerup' || e.type === 'pointercancel')) touches.delete(e.pointerId);
      if (!lp) return;
      if (e && e.type === 'pointermove' && (e.pointerId !== lp.pid || Math.hypot(e.clientX - lp.x, e.clientY - lp.y) < 9)) return;
      clearTimeout(lp.timer); lp = null;
    };
    el.addEventListener('pointermove', cancelLp, { passive: true });
    el.addEventListener('pointerup', cancelLp);
    el.addEventListener('pointercancel', cancelLp);
    window.addEventListener('pointerup', (e) => touches.delete(e.pointerId));
    window.addEventListener('pointercancel', (e) => touches.delete(e.pointerId));
    this.scroller.addEventListener('scroll', () => cancelLp(), { passive: true });
  }

  openContextMenu(idx, tile) {
    const item = this.items[idx];
    if (!item) return;
    const items = [
      { label: 'Info', icon: 'info', onClick: () => openInfoForItem(item, this, idx) },
      { label: item.fav ? 'Unfavourite' : 'Favourite', icon: item.fav ? 'heart-fill' : 'heart', hidden: !havePerm('photos.favorite'), onClick: () => toggleFavItem(item, this) },
      { label: 'Share', icon: 'share', hidden: !havePerm('photos.download'), onClick: () => shareIds([item.id]) },
      { label: 'Add to album', icon: 'album', hidden: !havePerm('albums.manage'), onClick: () => pickAlbumFor([item.id]) },
      { label: 'Select', icon: 'select', hidden: !canSelect(), onClick: () => { enterSelectMode(this); toggleSelect(item.id); } },
    ];
    if (this.opts.contextItems) items.push(...this.opts.contextItems(item, idx));
    openMenu(tile, items);
  }

  // Select mode: tap toggles one; a horizontal drag sweeps a run (vertical drag
  // scrolls natively thanks to touch-action: pan-y); mouse drags sweep freely.
  selectPointerDown(e, idx) {
    const item = this.items[idx];
    if (!item) return;
    const g = this;
    const s = { idx, x: e.clientX, y: e.clientY, sweeping: false, target: !state.selected.has(item.id),
                base: new Set(state.selected), last: idx, pid: e.pointerId, mouse: e.pointerType === 'mouse' };
    const move = (ev) => {
      if (ev.pointerId !== s.pid) return;
      const dx = ev.clientX - s.x, dy = ev.clientY - s.y;
      if (!s.sweeping) {
        if (Math.hypot(dx, dy) < 8) return;
        if (!s.mouse && Math.abs(dy) > Math.abs(dx)) { cleanup(); return; }   // vertical → native scroll
        s.sweeping = true;
        try { g.el.setPointerCapture(s.pid); } catch (_) {}
        g.applySweep(s, s.idx);
      }
      ev.preventDefault();
      s.cx = ev.clientX; s.cy = ev.clientY;
      g.sweepHit(s);
      g.autoScroll(s);
    };
    const up = (ev) => {
      if (ev.pointerId !== s.pid) return;
      if (!s.sweeping && ev.type === 'pointerup') toggleSelect(item.id);
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      g.stopAutoScroll();
      g.sweep = null;
    };
    this.sweep = s;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  sweepHit(s) {
    const idx = this.indexAtPoint(s.cx, s.cy);
    if (idx >= 0 && idx !== s.last) { s.last = idx; this.applySweep(s, idx); }
  }
  applySweep(s, cur) {
    const lo = Math.min(s.idx, cur), hi = Math.max(s.idx, cur);
    const sel = new Set(s.base);
    for (let i = lo; i <= hi; i++) {
      const it = this.items[i];
      if (!it) continue;
      if (s.target) sel.add(it.id); else sel.delete(it.id);
    }
    state.selected = sel;
    this.refreshSelection();
    updateSelCount();
  }
  autoScroll(s) {
    const r = this.scroller.getBoundingClientRect();
    const EDGE = 80;
    let v = 0;
    if (s.cy < r.top + EDGE + this.padTop * 0.4) v = -Math.ceil((r.top + EDGE + this.padTop * 0.4 - s.cy) / 5);
    else if (s.cy > r.bottom - EDGE) v = Math.ceil((s.cy - (r.bottom - EDGE)) / 5);
    this.autoV = v;
    if (v && !this.autoRaf) {
      const step = () => {
        this.autoRaf = null;
        if (!this.sweep || !this.autoV) return;
        this.scroller.scrollTop += this.autoV;
        this.paint();
        this.sweepHit(this.sweep);
        this.autoRaf = requestAnimationFrame(step);
      };
      this.autoRaf = requestAnimationFrame(step);
    }
  }
  stopAutoScroll() { this.autoV = 0; if (this.autoRaf) { cancelAnimationFrame(this.autoRaf); this.autoRaf = null; } }

  // Two-finger pinch changes the column count; ctrl/⌘+wheel (trackpad pinch) too.
  bindPinch() {
    const sc = this.scroller;
    let d0 = 0, mid = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    sc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        d0 = dist(e.touches);
        mid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      }
    }, { passive: true });
    sc.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !d0) return;
      e.preventDefault();
      const ratio = dist(e.touches) / d0;
      if (ratio > 1.3 || ratio < 0.77) {
        const anchor = this.anchorAt(mid.x, mid.y);
        if (setGridZoom(GRID_ZOOM.level + (ratio > 1 ? -1 : 1), anchor)) this.onZoomed();
        d0 = dist(e.touches);
      }
    }, { passive: false });
    sc.addEventListener('touchend', (e) => { if (e.touches.length < 2) d0 = 0; }, { passive: true });
    let wheelAcc = 0, wheelT = 0;
    sc.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const now = performance.now();
      if (now - wheelT > 400) wheelAcc = 0;
      wheelT = now;
      wheelAcc += e.deltaY;
      if (Math.abs(wheelAcc) > 40) {
        const anchor = this.anchorAt(e.clientX, e.clientY);
        if (setGridZoom(GRID_ZOOM.level + (wheelAcc < 0 ? -1 : 1), anchor)) this.onZoomed();
        wheelAcc = 0;
      }
    }, { passive: false });
  }
  anchorAt(x, y) {
    const idx = this.indexAtPoint(x, y);
    if (idx < 0) return null;
    const sr = this.scroller.getBoundingClientRect();
    return { grid: this, idx, screenY: y - sr.top - (this.cellW / 2) };
  }
  onZoomed() { if (this.opts.onZoom) this.opts.onZoom(this); }

  // Live Photo preview on mouse hover only — never touch/pen (a finger sweeping
  // a grid would otherwise stream a video per tile; see v1.5 notes).
  bindHoverPreview() {
    if (!canHover()) return;
    let vid = null, timer = null, curTile = null;
    const stop = () => {
      clearTimeout(timer); timer = null; curTile = null;
      if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); vid.remove(); vid = null; }
    };
    this.el.addEventListener('pointerover', (e) => {
      window.__auroraPerf.lastPointerType = e.pointerType || '?';
      if (e.pointerType !== 'mouse' || state.selectMode) return;
      const tile = e.target.closest('.tile');
      if (!tile || tile === curTile) return;
      stop();
      const item = this.items[+tile.dataset.idx];
      if (!item || !item.live_video_id) return;
      curTile = tile;
      timer = setTimeout(() => {
        if (curTile !== tile || !tile.isConnected) return;
        vid = document.createElement('video');
        vid.className = 'tile-live-preview';
        vid.muted = true; vid.loop = true; vid.playsInline = true; vid.preload = 'auto';
        vid.src = `/api/aurora/video/${item.live_video_id}`;
        tile.appendChild(vid);
        window.__auroraPerf.previewsCreated++;
        vid.play().catch(() => {});
      }, 180);
    });
    this.el.addEventListener('pointerout', (e) => {
      if (curTile && !curTile.contains(e.relatedTarget)) stop();
    });
    this.scroller.addEventListener('scroll', () => { if (curTile) stop(); }, { passive: true });
  }
}

// Re-flow every visible grid on resize (sidebar collapse, rotation, window size).
window.addEventListener('resize', debounce(() => {
  allGrids.forEach(g => { if (g.isShown()) g.relayout(); else g.dirty = true; });
}, 120));

// ── Shared item actions used by grids, the viewer and select mode ─────────
async function toggleFavItem(item, grid) {
  if (!havePerm('photos.favorite')) return;
  try {
    const res = await postJSON(`/api/aurora/fav/${item.id}`, {});
    setFavLocal(item.id, !!res.fav);
    toast(res.fav ? 'Added to Favourites' : 'Removed from Favourites', 1500);
  } catch (_) { toast('Couldn’t update favourite'); }
}
// Keep every in-memory copy of an asset (library index, open grids, viewer) in sync.
function setFavLocal(id, fav) {
  const v = fav ? 1 : 0;
  const a = state.assets.find(x => x.id === id);
  if (a) a.fav = v;
  allGrids.forEach(g => {
    for (const it of g.items) if (it.id === id) it.fav = v;
    g.updateById(id);
  });
  for (const it of state.lightboxItems) if (it.id === id) it.fav = v;
  if (typeof syncViewerFav === 'function') syncViewerFav();
}
