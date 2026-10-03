/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — select.js
   Select mode (the tab bar becomes an action bar; swipe across tiles to pick a
   run) and every bulk action: share/download, favourite, tag, album, hide,
   remove. The share / album pickers are also used for single photos from the
   viewer and long-press menus.
   ════════════════════════════════════════════════════════════════════════ */

function activeGrid() {
  if (typeof detailIsOpen === 'function' && detailIsOpen()) return detailGrid;
  if (state.screen === 'library') return libGrid;
  if (state.screen === 'search') return searchGrid;
  return null;
}
function enterSelectMode(grid) {
  if (!canSelect()) return;
  grid = grid || activeGrid();
  if (!grid) return;
  state.selectMode = true;
  state.selectGrid = grid;
  state.selectList = grid.items;
  state.selected = new Set();
  document.body.classList.add('select-mode');
  setTabbarMin(false);
  updateSelCount();
}
function toggleSelectMode() { if (state.selectMode) exitSelectMode(); else enterSelectMode(activeGrid()); }
function exitSelectMode() {
  state.selectMode = false;
  state.selected = new Set();
  state.selectGrid = null;
  document.body.classList.remove('select-mode');
  refreshSelectionVisuals();
}
function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  refreshSelectionVisuals();
  updateSelCount();
}
function refreshSelectionVisuals() { allGrids.forEach(g => g.refreshSelection()); }
function updateSelCount() {
  const n = state.selected.size;
  $('selCount').textContent = n ? plural(n, 'item') + ' selected' : 'Select items';
  document.querySelector('.select-actions').classList.toggle('empty', n === 0);
}
function selSelectAll() {
  const list = state.selectList || [];
  const all = list.length && list.every(it => state.selected.has(it.id));
  state.selected = all ? new Set() : new Set(list.map(it => it.id));
  refreshSelectionVisuals();
  updateSelCount();
}
function selectedIds() {
  const ids = [...state.selected];
  if (!ids.length) toast('Select some photos first');
  return ids;
}
// Items selected in the current grid (for fav state etc.).
function selectedItems() {
  const set = state.selected;
  return (state.selectList || []).filter(it => set.has(it.id));
}
// After a bulk change that removes items from the current view.
function dropFromViews(ids) {
  allGrids.forEach(g => { if (g !== libGrid) g.removeIds(ids); });
  loadStats();
  loadIndex();
}

// ── Share / download ──────────────────────────────────────────────────────
// Native share sheet when the browser offers one with files (secure contexts);
// otherwise download the original (one) or a streamed zip (many).
const SHARE_MAX = 30;
const SHARE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heic', 'image/webp': 'webp', 'image/gif': 'gif', 'image/tiff': 'tif', 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/webm': 'webm' };
async function shareIds(ids) {
  if (!ids.length) return;
  if (navigator.share && navigator.canShare && ids.length <= SHARE_MAX) {
    toast(ids.length === 1 ? 'Preparing…' : `Preparing ${ids.length} items…`, 4000);
    try {
      const files = [];
      for (const id of ids) {
        const resp = await fetch(`/api/aurora/original/${id}`);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        files.push(new File([blob], `aurora-${id}.${SHARE_EXT[blob.type] || 'jpg'}`, { type: blob.type || 'application/octet-stream' }));
      }
      if (files.length && navigator.canShare({ files })) {
        $('toast').classList.remove('show');
        await navigator.share({ files, title: files.length === 1 ? 'Aurora photo' : `${files.length} Aurora photos` });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  downloadIds(ids);
}
function downloadIds(ids) {
  const a = document.createElement('a');
  a.style.display = 'none';
  if (ids.length === 1) {
    a.href = `/api/aurora/original/${ids[0]}?dl=1`;
    a.download = '';
    toast('Downloading…');
  } else {
    const capped = ids.slice(0, 200);
    a.href = `/api/aurora/share/zip?ids=${capped.join(',')}`;
    a.download = 'aurora-photos.zip';
    toast(ids.length > 200 ? `Downloading the first 200 of ${ids.length} as a zip…` : `Preparing ${capped.length} items as a zip…`);
  }
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}
function shareSelection() { const ids = selectedIds(); if (ids.length) shareIds(ids); }

// ── Favourite ─────────────────────────────────────────────────────────────
async function selFavourite() {
  const ids = selectedIds();
  if (!ids.length) return;
  const items = selectedItems();
  const fav = items.some(it => !it.fav) ? 1 : 0;          // all already favourites → unfavourite
  try {
    await postJSON('/api/aurora/fav/bulk', { assetIds: ids, fav });
    ids.forEach(id => setFavLocal(id, !!fav));
    toast(fav ? `Added ${plural(ids.length, 'item')} to Favourites` : `Removed ${plural(ids.length, 'item')} from Favourites`);
    exitSelectMode();
  } catch (e) { toast('Couldn’t update favourites: ' + e.message); }
}

// ── Tags ──────────────────────────────────────────────────────────────────
async function selStartAddTag() {
  const ids = selectedIds();
  if (!ids.length) return;
  const node = document.createElement('div');
  node.innerHTML = `
    <div class="group pad" style="display:flex;gap:8px;align-items:center">
      <input id="selTagInput" placeholder="New or existing tag" autocomplete="off" spellcheck="false" maxlength="80" enterkeyhint="done"
        style="flex:1;height:44px;border:0;border-radius:10px;padding:0 12px;background:var(--surface-2);color:var(--label);font-size:16px;outline:none">
      <button type="button" class="btn" id="selAddConfirmBtn">Add</button>
    </div>
    <div class="group-label">Your tags</div>
    <div class="group" id="selTagList"><div class="row muted">Loading…</div></div>`;
  const sheet = openSheet({ title: 'Add a tag', subtitle: `To ${plural(ids.length, 'item')}`, node });
  const input = node.querySelector('#selTagInput');
  const apply = async (name) => {
    name = (name || '').trim();
    if (!name) return;
    const done = btnBusy(node.querySelector('#selAddConfirmBtn'), 'Tagging');
    try {
      const r = await postJSON('/api/aurora/tags/bulk', { op: 'add', name, assetIds: ids });
      sheet.close();
      toast(`Tagged ${plural(r.added || 0, 'item')} “${r.name}”`);
      assetCache.clear();
      exitSelectMode();
    } catch (e) { done(); toast('Couldn’t tag: ' + e.message); }
  };
  node.querySelector('#selAddConfirmBtn').addEventListener('click', () => apply(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(input.value); } });
  setTimeout(() => input.focus(), 350);
  try {
    const tags = await getJSON('/api/aurora/tags');
    const list = node.querySelector('#selTagList');
    list.innerHTML = tags.length ? tags.map(t =>
      `<button type="button" class="row" data-name="${escapeHtml(t.name)}">${ic('tag')}<span class="row-label">${escapeHtml(t.name)}</span><span class="val">${t.count.toLocaleString()}</span></button>`).join('')
      : '<div class="row muted">No tags yet. Type a name above.</div>';
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-name]'); if (b) apply(b.dataset.name); });
  } catch (_) {}
}
async function selStartRemoveTag() {
  const ids = selectedIds();
  if (!ids.length) return;
  const node = document.createElement('div');
  node.innerHTML = '<div class="group" id="selRmTagList"><div class="row muted">Loading…</div></div>';
  const sheet = openSheet({ title: 'Remove a tag', subtitle: `From ${plural(ids.length, 'item')}`, node });
  try {
    const tags = await postJSON('/api/aurora/tags/for-assets', { assetIds: ids });
    const list = node.querySelector('#selRmTagList');
    list.innerHTML = tags.length ? tags.map(t =>
      `<button type="button" class="row" data-id="${t.id}" data-name="${escapeHtml(t.name)}">${ic('tag')}<span class="row-label">${escapeHtml(t.name)}</span><span class="val">${t.count}</span></button>`).join('')
      : '<div class="row muted">None of the selected items have tags.</div>';
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      try {
        const r = await postJSON('/api/aurora/tags/bulk', { op: 'remove', tagId: +b.dataset.id, assetIds: ids });
        sheet.close();
        toast(`Removed “${b.dataset.name}” from ${plural(r.removed || 0, 'item')}`);
        assetCache.clear();
        exitSelectMode();
      } catch (err) { toast('Couldn’t remove the tag: ' + err.message); }
    });
  } catch (_) { node.querySelector('#selRmTagList').innerHTML = '<div class="row muted">Couldn’t load tags.</div>'; }
}

// ── Albums ────────────────────────────────────────────────────────────────
async function pickAlbumFor(ids) {
  if (!ids || !ids.length) { toast('Select some photos first'); return; }
  const node = document.createElement('div');
  node.innerHTML = `<div class="group"><button type="button" class="row accent-text" data-new="1">${ic('plus')}<span class="row-label">New album…</span></button></div>
    <div class="group-label">Albums</div><div class="group" id="pickAlbumList"><div class="row muted">Loading…</div></div>`;
  const sheet = openSheet({ title: 'Add to album', subtitle: plural(ids.length, 'item'), node });
  const add = async (albumId, albumName) => {
    try {
      const r = await postJSON(`/api/aurora/albums/${albumId}/assets`, { add: ids });
      sheet.close();
      const skipped = ids.length - (r.added || 0);
      toast(`Added ${plural(r.added || 0, 'item')} to “${albumName}”` + (skipped ? ` (${skipped} already there)` : ''));
      if (state.selectMode) exitSelectMode();
      collectionsDirty = true;
    } catch (e) { toast('Couldn’t add to the album: ' + e.message); }
  };
  node.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-album], [data-new]');
    if (!b) return;
    if (b.dataset.new) {
      const name = await uiPrompt({ title: 'New album', placeholder: 'Album name', ok: 'Create', maxlength: 120 });
      if (!name) return;
      try { const r = await postJSON('/api/aurora/albums', { name }); add(r.id, r.name); }
      catch (err) { toast('Couldn’t create the album: ' + err.message); }
      return;
    }
    add(+b.dataset.album, b.dataset.name);
  });
  try {
    const data = await getJSON('/api/aurora/albums');
    const list = node.querySelector('#pickAlbumList');
    const albums = data.user || [];
    list.innerHTML = albums.length ? albums.map(al => `
      <button type="button" class="row" data-album="${al.id}" data-name="${escapeHtml(al.name)}">
        ${al.cover_id ? `<img class="row-thumb" alt="" src="${thumbUrl(al.cover_id)}">` : `<span class="itile" style="--c:var(--c-purple)">${ic('collections')}</span>`}
        <span class="row-label">${escapeHtml(al.name)}<small>${plural(al.count, 'item')}</small></span></button>`).join('')
      : '<div class="row muted">No albums yet.</div>';
  } catch (_) {}
}
function selStartAddToAlbum() { const ids = selectedIds(); if (ids.length) pickAlbumFor(ids); }

// ── Hide / remove / context actions ───────────────────────────────────────
async function selHidePhotos(unhide) {
  const ids = selectedIds();
  if (!ids.length) return;
  try {
    await postJSON('/api/aurora/assets/privacy', { assetIds: ids, hidden: unhide ? 0 : 1 });
    toast(unhide ? `${plural(ids.length, 'item')} unhidden` : `${plural(ids.length, 'item')} hidden`);
    exitSelectMode();
    dropFromViews(ids);
  } catch (e) { toast('Couldn’t update: ' + e.message); }
}
async function selRemovePhotos() {
  const ids = selectedIds();
  if (!ids.length) return;
  const ok = await uiConfirm({
    title: `Remove ${plural(ids.length, 'item')}?`,
    message: 'They’ll be hidden everywhere and won’t re-import. The original files are kept, and you can restore them from Recently removed.',
    ok: 'Remove', danger: true,
  });
  if (!ok) return;
  try {
    await postJSON('/api/aurora/assets/remove', { assetIds: ids });
    toast(`${plural(ids.length, 'item')} removed`);
    exitSelectMode();
    dropFromViews(ids);
  } catch (e) { toast('Couldn’t remove: ' + e.message); }
}
function openSelMoreMenu(anchor) {
  const kind = typeof currentDetailKind === 'function' ? currentDetailKind() : null;
  const n = state.selected.size;
  openMenu(anchor, [
    { label: 'Download originals', icon: 'download', hidden: !havePerm('photos.download'), disabled: !n, onClick: () => { const ids = selectedIds(); if (ids.length) downloadIds(ids); } },
    { label: 'Remove tag', icon: 'tag', hidden: !havePerm('photos.tag'), disabled: !n, onClick: selStartRemoveTag },
    { label: 'Remove from album', icon: 'minus', hidden: !(kind === 'album' && havePerm('albums.manage')), disabled: !n, onClick: () => removeSelectionFromAlbum() },
    { label: kind === 'hidden' ? 'Unhide' : 'Hide', icon: kind === 'hidden' ? 'unlock' : 'lock', hidden: !havePerm('photos.hidden'), disabled: !n, onClick: () => selHidePhotos(kind === 'hidden') },
    { sep: true },
    { label: 'Restore to library', icon: 'restore', hidden: !(kind === 'removed' && havePerm('photos.delete')), disabled: !n, onClick: () => restoreIds([...state.selected]) },
    { label: 'Remove from library', icon: 'trash', danger: true, hidden: kind === 'removed' || !havePerm('photos.delete'), disabled: !n, onClick: selRemovePhotos },
  ], { title: n ? plural(n, 'item') + ' selected' : undefined });
}
