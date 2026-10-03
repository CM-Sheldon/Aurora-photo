/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — sheets.js
   UI primitives: bottom sheets (drag down to dismiss), alert/confirm/prompt
   dialogs (Promise based, replacing window.prompt/confirm), popover menus, and
   the shared date-range sheet (dual slider) used by Library, Places and Search.
   ════════════════════════════════════════════════════════════════════════ */

// ── Bottom sheets ──────────────────────────────────────────────────────────
const openSheets = [];   // stack: { el, close, persistent }

function syncBackdrop() {
  const bd = $('sheetBackdrop');
  if (bd) bd.classList.toggle('show', openSheets.length > 0);
}
$('sheetBackdrop').addEventListener('click', () => {
  const top = openSheets[openSheets.length - 1];
  if (top && !top.persistent) top.close();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.menu')) { closeMenus(); return; }
  const top = openSheets[openSheets.length - 1];
  if (top && !top.persistent) { e.stopPropagation(); top.close(); }
}, true);

// Drag-to-dismiss on a sheet's grab area / header (touch + mouse).
function makeSheetDraggable(sheetEl, handles, onDismiss) {
  let startY = 0, dy = 0, t0 = 0, active = false;
  const down = (e) => {
    if (e.button > 0) return;
    if (e.target.closest('button, input, select, a')) return;
    active = true; startY = e.clientY; dy = 0; t0 = performance.now();
    sheetEl.classList.add('dragging');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
  };
  const move = (e) => {
    if (!active) return;
    dy = Math.max(0, e.clientY - startY);
    sheetEl.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (!active) return;
    active = false;
    sheetEl.classList.remove('dragging');
    sheetEl.style.transform = '';
    const v = dy / Math.max(1, performance.now() - t0);
    if (dy > 110 || (dy > 30 && v > 0.6)) onDismiss();
  };
  handles.filter(Boolean).forEach(h => {
    h.addEventListener('pointerdown', down);
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });
}

// openSheet({ title, subtitle, html | node, foot, cls, onClose, persistent }) → { el, body, close }
function openSheet(opts) {
  const el = document.createElement('section');
  el.className = 'sheet' + (opts.cls ? ' ' + opts.cls : '');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="sheet-grab-area"><div class="grab"></div></div>
    ${opts.title != null ? `<div class="sheet-head"><div style="flex:1;min-width:0"><h3>${escapeHtml(opts.title)}</h3>${opts.subtitle ? `<p>${escapeHtml(opts.subtitle)}</p>` : ''}</div>
      <button type="button" class="close-btn" aria-label="Close">${ic('x')}</button></div>` : ''}
    <div class="sheet-body"></div>
    ${opts.foot ? `<div class="sheet-foot">${opts.foot}</div>` : ''}`;
  const body = el.querySelector('.sheet-body');
  if (opts.node) body.appendChild(opts.node);
  else if (opts.html) body.innerHTML = opts.html;
  $('sheetHost').appendChild(el);
  let closed = false;
  const entry = {
    el, body, persistent: !!opts.persistent,
    close() {
      if (closed) return;
      closed = true;
      el.classList.remove('open');
      const i = openSheets.indexOf(entry);
      if (i >= 0) openSheets.splice(i, 1);
      syncBackdrop();
      setTimeout(() => el.remove(), 450);
      if (opts.onClose) opts.onClose();
    },
  };
  const x = el.querySelector('.sheet-head .close-btn');
  if (x) x.addEventListener('click', () => entry.close());
  makeSheetDraggable(el, [el.querySelector('.sheet-grab-area'), el.querySelector('.sheet-head')], () => entry.close());
  openSheets.push(entry);
  syncBackdrop();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  applyPermissionsToUI(el);
  return entry;
}
function closeAllSheets() { [...openSheets].forEach(s => s.close()); }

// Static sheets that live in the markup (e.g. #accountSheet).
const staticSheets = new Map();
function showStaticSheet(el, onClose) {
  if (staticSheets.has(el)) return;
  const entry = { el, persistent: false, close() { hideStaticSheet(el); if (onClose) onClose(); } };
  staticSheets.set(el, entry);
  openSheets.push(entry);
  syncBackdrop();
  el.classList.add('open');
  if (!el.dataset.dragWired) {
    el.dataset.dragWired = '1';
    makeSheetDraggable(el, [el.querySelector('.sheet-grab-area'), el.querySelector('.acct-head')], () => { const s = staticSheets.get(el); if (s) s.close(); });
  }
}
function hideStaticSheet(el) {
  const entry = staticSheets.get(el);
  if (!entry) return;
  staticSheets.delete(el);
  const i = openSheets.indexOf(entry);
  if (i >= 0) openSheets.splice(i, 1);
  el.classList.remove('open');
  syncBackdrop();
}

// ── Dialogs ────────────────────────────────────────────────────────────────
// uiDialog({ title, message, icon, input: { value, placeholder, type, inputmode, maxlength },
//            actions: [{ label, value, style: 'strong'|'danger'|'' }] }) → Promise<{ value, input }>
function uiDialog(opts) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'dialog-overlay';
    const actions = opts.actions || [{ label: 'OK', value: true, style: 'strong' }];
    ov.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true">
        ${opts.icon ? `<div class="dialog-icon">${ic(opts.icon)}</div>` : ''}
        ${opts.title ? `<h3>${escapeHtml(opts.title)}</h3>` : ''}
        ${opts.message ? `<p class="dialog-msg">${escapeHtml(opts.message)}</p>` : ''}
        ${opts.input ? `<input type="${opts.input.type || 'text'}" autocomplete="off" spellcheck="false"
            ${opts.input.inputmode ? `inputmode="${opts.input.inputmode}"` : ''}
            ${opts.input.maxlength ? `maxlength="${opts.input.maxlength}"` : ''}
            placeholder="${escapeHtml(opts.input.placeholder || '')}">` : ''}
        <div class="dialog-actions${actions.length > 2 ? ' stack' : ''}">
          ${actions.map((a, i) => `<button type="button" class="dbtn ${a.style || ''}" data-i="${i}">${escapeHtml(a.label)}</button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector('input');
    if (input) { input.value = opts.input.value || ''; setTimeout(() => { input.focus(); input.select(); }, 60); }
    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      resolve({ value, input: input ? input.value : null });
    };
    const cancelValue = (actions.find(a => a.cancel) || {}).value;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(cancelValue); }
      if (e.key === 'Enter' && input && document.activeElement === input) {
        e.preventDefault();
        const def = actions.find(a => a.style === 'strong' || a.style === 'danger');
        finish(def ? def.value : true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (b) finish(actions[+b.dataset.i].value);
      else if (e.target === ov && cancelValue !== undefined) finish(cancelValue);
    });
  });
}
async function uiAlert(title, message) {
  await uiDialog({ title, message, actions: [{ label: 'OK', value: true, style: 'strong' }] });
}
async function uiConfirm(opts) {
  if (typeof opts === 'string') opts = { message: opts };
  const r = await uiDialog({
    title: opts.title, message: opts.message, icon: opts.icon,
    actions: [
      { label: opts.cancel || 'Cancel', value: false, cancel: true },
      { label: opts.ok || 'OK', value: true, style: opts.danger ? 'danger' : 'strong' },
    ],
  });
  return r.value === true;
}
async function uiPrompt(opts) {
  const r = await uiDialog({
    title: opts.title, message: opts.message, icon: opts.icon,
    input: { value: opts.value || '', placeholder: opts.placeholder || '', type: opts.type, inputmode: opts.inputmode, maxlength: opts.maxlength },
    actions: [
      { label: opts.cancel || 'Cancel', value: false, cancel: true },
      { label: opts.ok || 'OK', value: true, style: 'strong' },
    ],
  });
  if (r.value !== true) return null;
  const v = (r.input || '').trim();
  return v || null;
}

// ── Popover menus ──────────────────────────────────────────────────────────
// openMenu(anchorEl, items, { title }) — items: { label, icon, danger, disabled,
// checked, hidden, onClick } or { sep: true }.
function closeMenus() {
  document.querySelectorAll('.menu, .menu-catcher').forEach(m => m.remove());
}
function openMenu(anchor, items, opts = {}) {
  closeMenus();
  const catcher = document.createElement('div');
  catcher.className = 'menu-catcher';
  catcher.style.cssText = 'position:fixed;inset:0;z-index:299;';
  catcher.addEventListener('pointerdown', (e) => { e.preventDefault(); closeMenus(); });
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  let html = opts.title ? `<div class="menu-title">${escapeHtml(opts.title)}</div>` : '';
  const visible = items.filter(it => it && !it.hidden);
  visible.forEach((it, i) => {
    if (it.sep) { html += '<div class="menu-gap"></div>'; return; }
    html += `<button type="button" role="menuitem" class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}>
      ${it.checked != null ? `<span class="tick">${it.checked ? ic('check', 'sm') : ''}</span>` : ''}
      <span>${escapeHtml(it.label)}</span>${it.icon ? ic(it.icon) : ''}</button>`;
  });
  menu.innerHTML = html;
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.menu-item');
    if (!b) return;
    const it = visible[+b.dataset.i];
    closeMenus();
    if (it && it.onClick) it.onClick();
  });
  const host = $('menuHost');
  host.appendChild(catcher);
  host.appendChild(menu);
  // Position next to the anchor, flipping above it if there's no room below.
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const rightSide = r.left + r.width / 2 > vw / 2;
  let left = rightSide ? r.right - mw : r.left;
  left = clamp(left, 12, vw - mw - 12);
  let top = r.bottom + 8, originY = 'top';
  if (top + mh > vh - 12) { top = r.top - mh - 8; originY = 'bottom'; }
  top = clamp(top, 12, vh - mh - 12);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.setProperty('--menu-origin', `${originY} ${rightSide ? 'right' : 'left'}`);
  return menu;
}
window.addEventListener('resize', closeMenus);

// ── Date-range sheet (dual-thumb slider over the library's month domain) ───
// openRangeSheet({ title, from, to, onChange(from, to), onDone(from, to) })
// from/to are month indices into state.monthBase … state.totalMonths-1.
function monthHistogram(buckets) {
  const out = new Array(buckets).fill(0);
  const total = Math.max(1, state.totalMonths);
  for (const a of state.assets) {
    if (!a.taken_at) continue;
    const mi = monthIndexOf(a.taken_at);
    const b = Math.min(buckets - 1, Math.floor((mi / total) * buckets));
    if (b >= 0) out[b]++;
  }
  return out;
}
function openRangeSheet(opts) {
  const max = Math.max(0, state.totalMonths - 1);
  let from = clamp(opts.from || 0, 0, max), to = clamp(opts.to == null ? max : opts.to, 0, max);
  if (!state.monthBase || max < 1) { toast('No dated photos yet'); return null; }
  const BUCKETS = 48;
  const hist = monthHistogram(BUCKETS);
  const hmax = Math.max(1, ...hist);
  const node = document.createElement('div');
  node.className = 'range-sheet';
  node.innerHTML = `
    <div class="range-readout"><b class="rs-label"></b></div>
    <div class="rs-hist">${hist.map(c => `<i style="height:${Math.max(2, Math.round((c / hmax) * 44))}px"></i>`).join('')}</div>
    <div class="dual-track">
      <div class="dual-fill"></div>
      <input type="range" class="rs-from" min="0" max="${max}" value="${from}" aria-label="From">
      <input type="range" class="rs-to" min="0" max="${max}" value="${to}" aria-label="To">
    </div>
    <div class="range-ticks"></div>
    <div class="chip-row wrap rs-quick">
      <button type="button" class="chip" data-q="12">Last 12 months</button>
      <button type="button" class="chip" data-q="thisyear">This year</button>
      <button type="button" class="chip" data-q="lastyear">Last year</button>
      <button type="button" class="chip" data-q="60">Last 5 years</button>
    </div>`;
  const fromEl = node.querySelector('.rs-from'), toEl = node.querySelector('.rs-to');
  const fill = node.querySelector('.dual-fill'), label = node.querySelector('.rs-label');
  const bars = [...node.querySelectorAll('.rs-hist i')];
  // Year ticks (Januaries, thinned to ~6).
  const ticks = node.querySelector('.range-ticks');
  const marks = [];
  for (let i = 0; i <= max; i++) if (new Date(addMonths(state.monthBase, i)).getMonth() === 0) marks.push(i);
  const step = Math.max(1, Math.ceil(marks.length / 6));
  for (let j = 0; j < marks.length; j += step) {
    const i = marks[j], pct = (i / Math.max(1, max)) * 100;
    if (pct > 94) continue;
    const t = document.createElement('span');
    t.textContent = new Date(addMonths(state.monthBase, i)).getFullYear();
    t.style.left = pct + '%';
    ticks.appendChild(t);
  }
  const render = () => {
    const a = (from / Math.max(1, max)) * 100, b = (to / Math.max(1, max)) * 100;
    // A range thumb at value v sits at v% of (track − thumb): compensate for the 28px thumb.
    fill.style.left = `calc(${a} * (100% - 28px) / 100 + 14px)`;
    fill.style.width = `calc(${Math.max(0, b - a)} * (100% - 28px) / 100)`;
    fromEl.style.zIndex = from > max / 2 ? 4 : 2;
    const full = from <= 0 && to >= max;
    label.textContent = full ? 'All time' : monthRangeLabel(from, to);
    const fb = Math.floor((from / Math.max(1, state.totalMonths)) * BUCKETS);
    const tb = Math.ceil(((to + 1) / Math.max(1, state.totalMonths)) * BUCKETS) - 1;
    bars.forEach((el, i) => el.classList.toggle('in', i >= fb && i <= tb));
  };
  const emit = () => { render(); if (opts.onChange) opts.onChange(from, to); };
  fromEl.addEventListener('input', () => { from = Math.min(+fromEl.value, to); fromEl.value = from; emit(); });
  toEl.addEventListener('input', () => { to = Math.max(+toEl.value, from); toEl.value = to; emit(); });
  node.querySelector('.rs-quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (!b) return;
    const now = new Date();
    const mi = (d) => clamp(monthIndexOf(d.getTime()), 0, max);
    const q = b.dataset.q;
    if (q === 'all') { from = 0; to = max; }
    else if (q === 'thisyear') { from = mi(new Date(now.getFullYear(), 0, 1)); to = max; }
    else if (q === 'lastyear') { from = mi(new Date(now.getFullYear() - 1, 0, 1)); to = mi(new Date(now.getFullYear() - 1, 11, 1)); }
    else { from = mi(new Date(now.getFullYear(), now.getMonth() - (+q - 1), 1)); to = max; }
    if (to < from) to = from;
    fromEl.value = from; toEl.value = to;
    emit();
  });
  render();
  const sheet = openSheet({
    title: opts.title || 'Date range', node,
    foot: `<button type="button" class="btn gray" data-act="reset">All time</button><button type="button" class="btn" data-act="done">Done</button>`,
    onClose: () => { if (opts.onDone) opts.onDone(from, to); },
  });
  sheet.el.querySelector('.sheet-foot').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'reset') { from = 0; to = max; fromEl.value = 0; toEl.value = max; emit(); }
    sheet.close();
  });
  return sheet;
}
