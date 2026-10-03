/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — collections.js
   Collections screen (On This Day · Pinned · Albums · Tags · Utilities) and
   the generic pushed "detail" view that shows any one collection: a user
   album, a smart album, a tag, a place, Hidden, or Recently removed.
   Also owns album management, the Hidden passcode flow and hide/remove/restore.
   ════════════════════════════════════════════════════════════════════════ */

let collectionsDirty = true, collectionsLoadedAt = 0;

async function loadCollections(force) {
  if (!force && !collectionsDirty && Date.now() - collectionsLoadedAt < 60 * 1000) return;
  collectionsDirty = false;
  collectionsLoadedAt = Date.now();
  loadMemories();
  try {
    const data = await getJSON('/api/aurora/albums');
    renderPinned(data.smart || []);
    renderAlbumsRow(data.user || []);
    renderUtilities(data.smart || []);
  } catch (_) {}
  try {
    const tags = (await getJSON('/api/aurora/tags')).filter(t => t.count > 0);
    $('tagsSection').hidden = !tags.length;
    $('tagsRow').innerHTML = tags.map(t => coverCardHtml({ id: t.cover_id, title: t.name, sub: plural(t.count, 'item'), attrs: `data-tag="${t.id}" data-name="${escapeHtml(t.name)}"` })).join('');
  } catch (_) {}
}
function coverCardHtml({ id, title, sub, attrs, icon, cls, size }) {
  return `<button type="button" class="cover-card${cls ? ' ' + cls : ''}${id ? '' : ' blank'}" ${attrs || ''}>
    ${id ? `<img loading="lazy" decoding="async" alt="" src="${thumbUrl(id, size || 'cover')}">` : ''}
    ${icon ? `<span class="cc-icon">${ic(icon)}</span>` : ''}
    <div class="cc-text"><b>${escapeHtml(title)}</b>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</div></button>`;
}

async function loadMemories() {
  try {
    const data = await getJSON('/api/aurora/memories');
    const has = data.years && data.years.length;
    $('memSection').hidden = !has;
    const strip = $('memoriesStrip');
    strip.textContent = '';
    if (!has) return;
    for (const y of data.years) {
      const cover = y.assets.find(a => a.kind === 'photo') || y.assets[0];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'memory-card';
      card.appendChild(progressiveImg(cover.id, 'preview'));
      const t = document.createElement('div');
      t.className = 'mc-text';
      t.innerHTML = `<div class="mc-kicker">On this day</div><b>${escapeHtml(data.day)}</b>
        <div class="mc-sub">${y.yearsAgo === 1 ? '1 year ago' : y.yearsAgo + ' years ago'} · ${y.year} · ${plural(y.count, 'item')}</div>`;
      card.appendChild(t);
      card.addEventListener('click', () => openLightboxWith(y.assets, 0, { fromRect: card.getBoundingClientRect() }));
      strip.appendChild(card);
    }
  } catch (_) { $('memSection').hidden = true; }
}

function renderPinned(smart) {
  const by = Object.fromEntries(smart.map(s => [s.id, s]));
  const cards = [];
  if (by.favorites) cards.push(coverCardHtml({ id: by.favorites.cover_id, title: 'Favourites', sub: by.favorites.count.toLocaleString(), icon: 'heart-fill', cls: 'square', attrs: 'data-smart="favorites"' }));
  if (by.videos) cards.push(coverCardHtml({ id: by.videos.cover_id, title: 'Videos', sub: by.videos.count.toLocaleString(), icon: 'video', cls: 'square', attrs: 'data-smart="videos"' }));
  if (by.added) cards.push(coverCardHtml({ id: by.added.cover_id, title: 'Recently added', sub: 'Newest imports', icon: 'clock', cls: 'square', attrs: 'data-smart="added"' }));
  $('pinnedRow').innerHTML = cards.join('');
}
function renderAlbumsRow(albums) {
  const html = albums.map(al => coverCardHtml({
    id: al.cover_id, title: al.name, sub: plural(al.count, 'item') + (al.share_token ? ' · Shared' : ''),
    icon: al.share_token ? 'link' : null, attrs: `data-album="${al.id}"`,
  }));
  if (havePerm('albums.manage')) html.push(`<button type="button" class="cover-card new" data-newalbum="1">${ic('plus')}New album</button>`);
  $('albumsRow').innerHTML = html.join('') || '<p class="group-foot" style="padding:0">No albums yet.</p>';
}
function renderUtilities(smart) {
  const hidden = smart.find(s => s.id === 'hidden');
  const rows = [];
  if (hidden && havePerm('photos.hidden')) rows.push(`<button type="button" class="row" data-util="hidden"><span class="itile" style="--c:var(--c-slate)">${ic('lock')}</span><span class="row-label">Hidden</span><span class="val">${state.privateUnlocked ? hidden.count.toLocaleString() : 'Locked'}</span>${ic('chev', 'chev')}</button>`);
  if (havePerm('photos.delete')) rows.push(`<button type="button" class="row" data-util="removed"><span class="itile" style="--c:var(--c-red)">${ic('trash')}</span><span class="row-label">Recently removed</span>${ic('chev', 'chev')}</button>`);
  if (havePerm('settings.view')) rows.push(`<button type="button" class="row" data-util="duplicates"><span class="itile" style="--c:var(--c-cyan)">${ic('dupes')}</span><span class="row-label">Duplicates</span>${ic('chev', 'chev')}</button>`);
  $('utilSection').hidden = !rows.length;
  $('utilList').innerHTML = rows.join('');
}
$('pinnedRow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-smart]');
  if (b) openSmartDetail(b.dataset.smart);
});
$('albumsRow').addEventListener('click', (e) => {
  if (e.target.closest('[data-newalbum]')) { createAlbumPrompt(); return; }
  const b = e.target.closest('[data-album]');
  if (b) openAlbumDetail(+b.dataset.album);
});
$('tagsRow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (b) openTagDetail({ id: +b.dataset.tag, name: b.dataset.name });
});
$('utilList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-util]');
  if (!b) return;
  if (b.dataset.util === 'hidden') openHiddenAlbum();
  else if (b.dataset.util === 'removed') openRemovedManager();
  else if (b.dataset.util === 'duplicates') openSettings('duplicates');
});

// ── Detail view (one collection) ──────────────────────────────────────────
// spec: { kind, title, sub, pageUrl | loadAll(), total, album, emptyTitle, emptyText }
const detailScreen = $('screen-detail'), detailScroll = $('detailScroll');
const detail = { spec: null, seq: 0, total: 0 };
const detailChrome = new ScrollChrome(detailScreen, detailScroll, { threshold: 160 });
const detailGrid = new VirtualGrid({
  el: $('detailGrid'), scroller: detailScroll, name: 'detail',
  padTop: () => $('detailHeader').offsetHeight + 2,
  padBottom: () => (isPhone() ? 130 : 40),
  onNearEnd: () => detailLoadMore(),
  onTap: (idx, item, tile) => {
    if (detailScreen.classList.contains('editing') && detail.spec && detail.spec.kind === 'album') {
      openMenu(tile, [
        { label: 'Use as album cover', icon: 'star', onClick: () => setAlbumCover(item.id) },
        { label: 'Remove from album', icon: 'minus', danger: true, onClick: () => removeFromAlbum([item.id]) },
      ]);
      return true;
    }
    return false;
  },
  contextItems: (item) => (detail.spec && detail.spec.kind === 'album' && havePerm('albums.manage')) ? [
    { sep: true },
    { label: 'Use as album cover', icon: 'star', onClick: () => setAlbumCover(item.id) },
    { label: 'Remove from album', icon: 'minus', danger: true, onClick: () => removeFromAlbum([item.id]) },
  ] : [],
});
function detailIsOpen() { return detailScreen.classList.contains('open'); }
function currentDetailKind() { return detailIsOpen() && detail.spec ? detail.spec.kind : null; }

async function openDetail(spec) {
  if (state.selectMode) exitSelectMode();
  closeMenus();
  detail.spec = spec;
  const seq = ++detail.seq;
  $('detailTitle').textContent = spec.title || '';
  $('detailSub').textContent = spec.sub || ' ';
  // Albums and Recently removed put Select in their ⋯ menu (room for the title).
  const hasMenu = spec.kind === 'album' || spec.kind === 'removed';
  $('detailMoreBtn').hidden = !hasMenu;
  $('detailSelectBtn').hidden = hasMenu || !canSelect();
  $('detailDoneBtn').hidden = true;
  detailScreen.classList.remove('editing');
  updateAlbumShareRow();
  $('detailEmpty').hidden = true;
  $('detailLoading').hidden = false;
  detailScreen.classList.add('open');
  detailScreen.setAttribute('aria-hidden', 'false');
  document.body.classList.add('detail-open');
  detailChrome.reset();
  detailGrid.hasMore = false;
  detailGrid.setItems([]);
  try {
    let items, total;
    if (spec.loadAll) { items = await spec.loadAll(); total = items.length; }
    else {
      const res = await getJSON(detailPageUrl(0, true));
      items = res.assets || [];
      total = res.total != null ? res.total : items.length;
    }
    if (seq !== detail.seq) return;
    detail.total = total;
    if (!spec.sub && spec.kind !== 'album') $('detailSub').textContent = plural(total, 'item');
    $('detailLoading').hidden = true;
    $('detailEmpty').hidden = items.length > 0;
    $('detailEmptyTitle').textContent = spec.emptyTitle || 'Nothing here yet';
    $('detailEmptyText').textContent = spec.emptyText || '';
    detailGrid.hasMore = !spec.loadAll && items.length < total;
    // The header may have grown (share row) — lay out after it settles.
    requestAnimationFrame(() => detailGrid.setItems(items));
  } catch (e) {
    if (seq !== detail.seq) return;
    $('detailLoading').hidden = true;
    $('detailEmpty').hidden = false;
    $('detailEmptyTitle').textContent = 'Couldn’t load this collection';
    $('detailEmptyText').textContent = e.message || '';
  }
}
function detailPageUrl(offset, withCount) {
  const u = detail.spec.pageUrl;
  return u + (u.includes('?') ? '&' : '?') + `limit=240&offset=${offset}` + (withCount ? '&count=1' : '') + (state.hideRaw ? '&hideRaw=1' : '');
}
async function detailLoadMore() {
  if (!detail.spec || !detail.spec.pageUrl || !detailGrid.hasMore) return;
  const seq = detail.seq;
  try {
    const res = await getJSON(detailPageUrl(detailGrid.items.length, false));
    if (seq !== detail.seq) return;
    const items = res.assets || [];
    detailGrid.hasMore = items.length > 0 && detailGrid.items.length + items.length < detail.total;
    detailGrid.appendItems(items);
  } catch (_) { detailGrid.hasMore = false; }
}
function closeDetail(instant) {
  if (!detailIsOpen()) return;
  if (state.selectMode && state.selectGrid === detailGrid) exitSelectMode();
  detailScreen.classList.remove('open', 'editing');
  detailScreen.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('detail-open');
  detail.spec = null;
  detail.seq++;
  if (instant) { detailScreen.classList.add('dragging'); requestAnimationFrame(() => detailScreen.classList.remove('dragging')); }
  setTimeout(() => { if (!detailIsOpen()) detailGrid.setItems([]); }, 400);
  if (state.screen === 'collections') loadCollections();
}
// iOS-style swipe from the left edge to go back.
(function edgeSwipeBack() {
  let x0 = 0, y0 = 0, dx = 0, on = false, decided = false;
  detailScreen.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (e.touches.length !== 1 || t.clientX > 28 || state.selectMode) return;
    on = true; decided = false; x0 = t.clientX; y0 = t.clientY; dx = 0;
  }, { passive: true });
  detailScreen.addEventListener('touchmove', (e) => {
    if (!on) return;
    const t = e.touches[0];
    dx = Math.max(0, t.clientX - x0);
    if (!decided) {
      if (Math.abs(t.clientY - y0) > Math.abs(dx) && Math.abs(t.clientY - y0) > 10) { on = false; return; }
      if (dx < 10) return;
      decided = true;
      detailScreen.classList.add('dragging');
    }
    e.preventDefault();
    detailScreen.style.transform = `translateX(${dx}px)`;
  }, { passive: false });
  const end = () => {
    if (!on) return;
    on = false;
    detailScreen.classList.remove('dragging');
    detailScreen.style.transform = '';
    if (decided && dx > window.innerWidth * 0.3) closeDetail();
  };
  detailScreen.addEventListener('touchend', end);
  detailScreen.addEventListener('touchcancel', end);
})();

function openSmartDetail(id) {
  if (id === 'favorites') openDetail({ kind: 'smart', title: 'Favourites', pageUrl: '/api/aurora/assets?fav=1', emptyTitle: 'No favourites yet', emptyText: 'Tap the heart on a photo to add it here.' });
  else if (id === 'videos') openDetail({ kind: 'smart', title: 'Videos', pageUrl: '/api/aurora/assets?kind=video' });
  else if (id === 'added') openDetail({ kind: 'smart', title: 'Recently added', sub: 'Newest imports first', pageUrl: '/api/aurora/assets?order=added' });
}
function openTagDetail(tag) {
  openDetail({ kind: 'tag', title: tag.name, pageUrl: `/api/aurora/assets?tag=${tag.id}`, emptyText: 'No visible photos carry this tag.' });
}
function openDetailMenu(anchor) {
  const spec = detail.spec;
  if (!spec) return;
  if (spec.kind === 'album') {
    const a = spec.album, can = havePerm('albums.manage');
    openMenu(anchor, [
      { label: 'Select', icon: 'select', hidden: !canSelect(), onClick: () => enterSelectMode(detailGrid) },
      { label: a.share_token ? 'Copy share link' : 'Create share link', icon: 'link', hidden: !can, onClick: () => (a.share_token ? copyAlbumShare() : toggleAlbumShare()) },
      { label: 'Turn off share link', icon: 'x', hidden: !can || !a.share_token, onClick: revokeAlbumShare },
      { label: 'Rename', icon: 'edit', hidden: !can, onClick: renameAlbum },
      { label: 'Edit cover & photos', icon: 'star', hidden: !can, onClick: toggleAlbumEdit },
      { sep: true },
      { label: 'Delete album', icon: 'trash', danger: true, hidden: !can, onClick: deleteAlbum },
    ]);
  } else if (spec.kind === 'removed') {
    openMenu(anchor, [
      { label: 'Select', icon: 'select', onClick: () => enterSelectMode(detailGrid) },
      { label: 'Restore all', icon: 'restore', disabled: !detailGrid.items.length, onClick: async () => {
        const ids = detailGrid.items.map(i => i.id);
        if (await uiConfirm({ title: `Restore ${plural(ids.length, 'item')}?`, message: 'They’ll return to the library.', ok: 'Restore all' })) restoreIds(ids);
      } },
    ]);
  }
}

// ── Albums ────────────────────────────────────────────────────────────────
async function createAlbumPrompt() {
  const name = await uiPrompt({ title: 'New album', placeholder: 'Album name', ok: 'Create', maxlength: 120 });
  if (!name) return;
  try {
    const r = await postJSON('/api/aurora/albums', { name });
    toast(`Album “${r.name}” created`);
    collectionsDirty = true;
    loadCollections(true);
    openAlbumDetail(r.id);
  } catch (e) { toast('Couldn’t create the album: ' + e.message); }
}
async function openAlbumDetail(id) {
  try {
    const data = await getJSON(`/api/aurora/albums/${id}/assets`);
    const assets = data.assets || [];
    const dated = assets.filter(a => a.taken_at).map(a => a.taken_at);
    const span = dated.length ? ` · ${fmtMonShort(Math.min(...dated))}${fmtMonShort(Math.min(...dated)) !== fmtMonShort(Math.max(...dated)) ? ' – ' + fmtMonShort(Math.max(...dated)) : ''}` : '';
    openDetail({
      kind: 'album', album: data.album, title: data.album.name,
      sub: plural(assets.length, 'item') + span,
      loadAll: async () => assets,
      emptyTitle: 'This album is empty', emptyText: 'Select photos in the Library and tap Album to add them.',
    });
  } catch (e) { toast('Couldn’t open the album: ' + e.message); }
}
function albumOf() { return detail.spec && detail.spec.kind === 'album' ? detail.spec.album : null; }
function toggleAlbumEdit() {
  const on = detailScreen.classList.toggle('editing');
  $('detailDoneBtn').hidden = !on;
  $('detailMoreBtn').hidden = on;
  if (on) toast('Tap a photo to make it the cover or remove it', 2600);
}
async function removeFromAlbum(ids) {
  const al = albumOf();
  if (!al) return;
  try {
    await postJSON(`/api/aurora/albums/${al.id}/assets`, { remove: ids });
    detailGrid.removeIds(ids);
    $('detailSub').textContent = plural(detailGrid.items.length, 'item');
    $('detailEmpty').hidden = detailGrid.items.length > 0;
    collectionsDirty = true;
    toast(ids.length === 1 ? 'Removed from album' : `${plural(ids.length, 'item')} removed from album`);
  } catch (e) { toast('Couldn’t remove: ' + e.message); }
}
function removeSelectionFromAlbum() { const ids = selectedIds(); if (ids.length) { removeFromAlbum(ids); exitSelectMode(); } }
async function setAlbumCover(assetId) {
  const al = albumOf();
  if (!al) return;
  try { await postJSON(`/api/aurora/albums/${al.id}`, { coverAssetId: assetId }); collectionsDirty = true; toast('Cover updated'); }
  catch (e) { toast('Couldn’t set the cover: ' + e.message); }
}
async function renameAlbum() {
  const al = albumOf();
  if (!al) return;
  const name = await uiPrompt({ title: 'Rename album', value: al.name, ok: 'Rename', maxlength: 120 });
  if (!name || name === al.name) return;
  try {
    const r = await postJSON(`/api/aurora/albums/${al.id}`, { name });
    al.name = r.name;
    $('detailTitle').textContent = r.name;
    collectionsDirty = true;
  } catch (e) { toast('Couldn’t rename: ' + e.message); }
}
async function deleteAlbum() {
  const al = albumOf();
  if (!al) return;
  const ok = await uiConfirm({ title: `Delete “${al.name}”?`, message: 'The album is deleted. The photos themselves are not touched.', ok: 'Delete', danger: true });
  if (!ok) return;
  try {
    await postJSON(`/api/aurora/albums/${al.id}/delete`, {});
    toast('Album deleted');
    collectionsDirty = true;
    closeDetail();
  } catch (e) { toast('Couldn’t delete: ' + e.message); }
}
// Public share link (anyone with the link can view the album).
function updateAlbumShareRow() {
  const al = albumOf();
  const row = $('albumShareRow');
  const on = !!(al && al.share_token);
  row.hidden = !on;
  if (on) $('albumShareUrl').value = location.origin + '/share/' + al.share_token;
}
async function toggleAlbumShare() {
  const al = albumOf();
  if (!al) return;
  try {
    const r = await postJSON(`/api/aurora/albums/${al.id}/share`, { enable: true });
    al.share_token = r.token;
    updateAlbumShareRow();
    detailGrid.relayout();
    collectionsDirty = true;
    copyAlbumShare(true);
  } catch (e) { toast('Couldn’t create the link: ' + e.message); }
}
async function revokeAlbumShare() {
  const al = albumOf();
  if (!al || !al.share_token) return;
  const ok = await uiConfirm({ title: 'Turn off the share link?', message: 'Anyone with the old link will no longer be able to open this album.', ok: 'Turn off', danger: true });
  if (!ok) return;
  try {
    await postJSON(`/api/aurora/albums/${al.id}/share`, { enable: false });
    al.share_token = null;
    updateAlbumShareRow();
    detailGrid.relayout();
    collectionsDirty = true;
    toast('Share link turned off');
  } catch (e) { toast('Couldn’t turn off the link: ' + e.message); }
}
function copyAlbumShare(justCreated) {
  const input = $('albumShareUrl');
  const msg = justCreated ? 'Share link created and copied' : 'Link copied';
  // Aurora is usually plain HTTP on a LAN, where navigator.clipboard is missing.
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(() => toast(msg), () => legacyCopy(input, msg));
  else legacyCopy(input, msg);
}
function legacyCopy(input, msg) {
  input.focus(); input.select();
  try { document.execCommand('copy'); toast(msg); }
  catch (_) { uiAlert('Share link', input.value); }
}

// ── Hidden album (passcode) ───────────────────────────────────────────────
let _passcodeCb = null;
function showPasscodeModal(subtitle, cb) {
  _passcodeCb = cb;
  $('passcodeSubtitle').textContent = subtitle || 'Enter your passcode to continue';
  $('passcodeInput').value = '';
  $('passcodeErr').textContent = '';
  $('passcodeOverlay').hidden = false;
  setTimeout(() => $('passcodeInput').focus(), 80);
}
function passcodeCancel() { $('passcodeOverlay').hidden = true; _passcodeCb = null; }
async function passcodeSubmit() {
  const input = $('passcodeInput');
  try {
    const r = await postJSON('/api/aurora/settings/passcode/verify', { passcode: input.value });
    if (r.ok) {
      state.privateUnlocked = true;
      $('passcodeOverlay').hidden = true;
      const cb = _passcodeCb; _passcodeCb = null;
      if (cb) cb();
    } else {
      $('passcodeErr').textContent = 'Incorrect passcode';
      input.style.animation = 'shake 0.35s';
      setTimeout(() => { input.style.animation = ''; input.value = ''; input.focus(); }, 350);
    }
  } catch (_) { $('passcodeErr').textContent = 'Connection error — try again'; }
}
$('passcodeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); passcodeSubmit(); }
  if (e.key === 'Escape') passcodeCancel();
});
function openHiddenAlbum() {
  const go = () => {
    openDetail({ kind: 'hidden', title: 'Hidden', pageUrl: '/api/aurora/assets?showHidden=1', emptyTitle: 'Nothing is hidden', emptyText: 'Hide a photo from its Info or the select bar and it moves here.' });
    collectionsDirty = true;
  };
  if (state.privateUnlocked) go(); else showPasscodeModal('Enter your passcode to see hidden photos', go);
}
async function togglePrivatePhoto(id, currentlyHidden) {
  try {
    await postJSON('/api/aurora/assets/privacy', { assetIds: [id], hidden: currentlyHidden ? 0 : 1 });
    assetCache.delete(id);
    toast(currentlyHidden ? 'Unhidden' : 'Hidden');
    if (viewerOpen()) closeLightbox();
    dropFromViews([id]);
  } catch (e) { toast('Couldn’t update: ' + e.message); }
}

// ── Remove / restore ──────────────────────────────────────────────────────
async function removeAssetFromLibrary(id) {
  const ok = await uiConfirm({
    title: 'Remove from library?',
    message: 'It’s hidden everywhere and won’t re-import. The original file is kept, and you can restore it from Recently removed.',
    ok: 'Remove', danger: true,
  });
  if (!ok) return;
  try {
    await postJSON('/api/aurora/assets/remove', { assetIds: [id] });
    assetCache.delete(id);
    toast('Removed from library');
    if (viewerOpen()) closeLightbox();
    dropFromViews([id]);
  } catch (e) { toast('Couldn’t remove: ' + e.message); }
}
function openRemovedManager() {
  openDetail({
    kind: 'removed', title: 'Recently removed', sub: 'Originals kept on disk',
    emptyTitle: 'Nothing has been removed', emptyText: 'Anything you remove from the library shows up here so you can undo it.',
    loadAll: async () => {
      const r = await getJSON('/api/aurora/assets/removed');
      return (r.removed || []).map(a => ({ id: a.id, kind: a.kind, path: a.path, taken_at: null, removed_at: a.removed_at }));
    },
  });
}
async function restoreIds(ids) {
  if (!ids.length) return;
  try {
    await postJSON('/api/aurora/assets/restore', { assetIds: ids });
    ids.forEach(id => assetCache.delete(id));
    toast(ids.length === 1 ? 'Restored to library' : `${plural(ids.length, 'item')} restored`);
    if (state.selectMode) exitSelectMode();
    if (viewerOpen() && currentDetailKind() === 'removed') closeLightbox();
    dropFromViews(ids);
  } catch (e) { toast('Couldn’t restore: ' + e.message); }
}
function restoreRemoved(id) { restoreIds([id]); }

registerScreen('collections', {
  enter() { loadCollections(); },
  reselect() { $('collectionsScroll').scrollTo({ top: 0, behavior: 'smooth' }); },
});
