/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — settings.js
   Settings is a navigation stack: a grouped root list and one .spage per
   area (markup in views/partials/settings.ejs). openSettings('page') jumps
   straight to a page from anywhere (e.g. Collections → Duplicates).

   The page logic below is v1.9's, re-skinned: same endpoints, same flows —
   in particular the GitHub updater (check → Update now → poll → hard reload)
   must keep working so installs can update themselves.
   ════════════════════════════════════════════════════════════════════════ */

const settingsNav = { stack: ['root'], returnTo: 'library' };
const SETTINGS_LOADERS = {
  root: () => loadSettingsRoot(),
  overview: () => loadOverview(),
  sources: () => loadSources(),
  display: () => syncDisplaySettings(),
  tags: () => loadTagManager(),
  captions: () => loadCaptions(),
  duplicates: () => {},
  users: () => loadUsers(),
  roles: () => loadRoles(),
  audit: () => loadAudit(),
  privacy: () => loadPrivacyStats(),
  maintenance: () => startWarmPoll(),
  update: () => { loadUpdateVersion(); checkForUpdates(); },
};
const spageEl = (name) => document.querySelector(`#settingsStack .spage[data-page="${name}"]`);

// Inject a back button + title into every sub-page.
document.querySelectorAll('#settingsStack .spage[data-title]').forEach((pg) => {
  const head = document.createElement('header');
  head.className = 'screen-head solid spage-head';
  head.innerHTML = `<button type="button" class="gbtn round back-btn" onclick="settingsBack()" aria-label="Back">${ic('back')}</button>
    <div class="sh-text"><h1>${escapeHtml(pg.dataset.title)}</h1></div>`;
  pg.querySelector('.scroller').prepend(head);
});

function openSettings(page) {
  if (state.screen !== 'settings') {
    settingsNav.returnTo = TAB_SCREENS.includes(state.screen) ? state.screen : state.lastTab;
    switchScreen('settings');
  }
  resetSettingsStack();
  if (page) openSettingsPage(page, { instant: true });
}
function resetSettingsStack() {
  settingsNav.stack.slice(1).forEach(leaveSettingsPage);
  settingsNav.stack = ['root'];
  document.querySelectorAll('#settingsStack .spage').forEach(pg => {
    pg.classList.add('no-anim');
    pg.classList.toggle('active', pg.dataset.page === 'root');
    pg.classList.remove('behind');
  });
  requestAnimationFrame(() => document.querySelectorAll('#settingsStack .spage').forEach(pg => pg.classList.remove('no-anim')));
  SETTINGS_LOADERS.root();
}
function closeSettings() {
  stopSettingsPolls();
  switchScreen(settingsNav.returnTo || state.lastTab || 'library');
}
function openSettingsPage(name, opts = {}) {
  const pg = spageEl(name);
  if (!pg) return;
  const cur = spageEl(settingsNav.stack[settingsNav.stack.length - 1]);
  if (opts.instant) { pg.classList.add('no-anim'); cur.classList.add('no-anim'); }
  cur.classList.remove('active');
  cur.classList.add('behind');
  pg.classList.add('active');
  pg.querySelector('.scroller').scrollTop = 0;
  settingsNav.stack.push(name);
  if (opts.instant) requestAnimationFrame(() => { pg.classList.remove('no-anim'); cur.classList.remove('no-anim'); });
  if (SETTINGS_LOADERS[name]) SETTINGS_LOADERS[name](opts);
}
function settingsBack() {
  if (settingsNav.stack.length <= 1) { closeSettings(); return; }
  const name = settingsNav.stack.pop();
  leaveSettingsPage(name);
  const pg = spageEl(name), prev = spageEl(settingsNav.stack[settingsNav.stack.length - 1]);
  pg.classList.remove('active');
  prev.classList.remove('behind');
  prev.classList.add('active');
}
function leaveSettingsPage(name) {
  if (name === 'captions') stopCaptionPolling();
  if (name === 'maintenance') stopWarmPoll();
}
function stopSettingsPolls() { stopCaptionPolling(); stopWarmPoll(); }
// Hide a root group (and its label) when every row in it is permission-hidden.
function tidySettingsGroups() {
  document.querySelectorAll('.settings-root .group').forEach(g => {
    const any = [...g.children].some(r => r.style.display !== 'none');
    g.style.display = any ? '' : 'none';
    const label = g.previousElementSibling;
    if (label && label.classList.contains('group-label')) label.style.display = any ? '' : 'none';
  });
}
// iOS-style swipe from the left edge pops a page.
(function () {
  const host = $('settingsStack');
  let x0 = 0, y0 = 0, dx = 0, on = false, decided = false, pg = null;
  host.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (e.touches.length !== 1 || t.clientX > 28) return;
    on = true; decided = false; x0 = t.clientX; y0 = t.clientY; dx = 0;
    pg = spageEl(settingsNav.stack[settingsNav.stack.length - 1]);
  }, { passive: true });
  host.addEventListener('touchmove', (e) => {
    if (!on) return;
    const t = e.touches[0];
    dx = Math.max(0, t.clientX - x0);
    if (!decided) {
      if (Math.abs(t.clientY - y0) > Math.abs(dx) && Math.abs(t.clientY - y0) > 10) { on = false; return; }
      if (dx < 10) return;
      decided = true;
      pg.classList.add('no-anim');
    }
    e.preventDefault();
    pg.style.transform = `translateX(${dx}px)`;
  }, { passive: false });
  const end = () => {
    if (!on) return;
    on = false;
    if (!pg) return;
    pg.classList.remove('no-anim');
    pg.style.transform = '';
    if (decided && dx > window.innerWidth * 0.3) settingsBack();
  };
  host.addEventListener('touchend', end);
  host.addEventListener('touchcancel', end);
})();
registerScreen('settings', {
  enter() { if (settingsNav.stack.length <= 1) SETTINGS_LOADERS.root(); },
  leave() { stopSettingsPolls(); },
  reselect() { resetSettingsStack(); },
});

async function loadSettingsRoot() {
  try {
    const v = await getJSON('/api/aurora/version');
    $('settingsVersionTag').textContent = v.version;
    $('settingsFootVersion').textContent = `Aurora ${v.version}`;
  } catch (_) {}
  loadStats();
  if (havePerm('users.manage')) {
    try { const r = await getJSON('/api/aurora/auth/admin/users'); $('sUsersVal').textContent = (r.users || []).length; } catch (_) {}
  }
}

// ── Overview ──────────────────────────────────────────────────────────────
async function loadOverview() {
  const host = $('settingsMetrics');
  try {
    const m = await getJSON('/api/aurora/settings/metrics');
    const lib = m.library || {}, th = m.thumbnails || {}, im = m.imports || {}, warm = th.warm || {};
    const group = (title, rows) => `<div class="group-label">${title}</div><div class="group">${rows.filter(Boolean).map(([k, v]) =>
      `<div class="row kv-row static"><span class="row-label">${k}</span><span class="val">${v}</span></div>`).join('')}</div>`;
    const n = (x) => (x || 0).toLocaleString();
    const warmPct = warm.total ? Math.round((warm.done / warm.total) * 100) : 0;
    host.innerHTML =
      group('Library', [
        ['Items', n(lib.total)], ['Photos', n(lib.photos)], ['Videos', n(lib.videos)], ['Live Photos', n(lib.live_photos)],
        ['Favourites', n(lib.favorites)], ['Places', n(lib.places)], ['No date', n(lib.undated)],
        ['Date range', lib.earliest && lib.latest ? `${fmtDate(lib.earliest)} – ${fmtDate(lib.latest)}` : '—'],
        lib.hidden ? ['Hidden', n(lib.hidden)] : null,
        lib.duplicates_hidden ? ['Duplicates hidden', n(lib.duplicates_hidden)] : null,
        lib.removed ? ['Removed', n(lib.removed)] : null,
      ]) +
      group('Storage', [['Originals', fmtBytes(lib.total_bytes)], ['Database', fmtBytes(lib.db_bytes)], ['Thumbnails', fmtBytes(th.bytes_approx)], ['Thumbnail files', n(th.count)]]) +
      group('Thumbnails', [['Status', warm.phase && warm.phase !== 'idle' ? `${warm.phase} · ${warmPct}%` : 'Idle'], ['Made this run', n(warm.generated)]]) +
      group('Imports', [['Import errors', n(im.total_errors)], ['Interrupted imports', n(im.interrupted)]]);
    $('removedCountTag').textContent = lib.removed ? n(lib.removed) : '';
  } catch (e) {
    host.innerHTML = `<p class="group-foot">Couldn’t load the overview: ${escapeHtml(e.message)}</p>`;
  }
}

// ── Sources & import ──────────────────────────────────────────────────────
let currentProto = 'smb', mountedPath = null;
function setProto(proto, btn) {
  currentProto = proto;
  document.querySelectorAll('#protoSeg [data-proto]').forEach(b => b.classList.toggle('on', b === btn));
  ['smb', 'nfs', 'local'].forEach(p => { $('proto-' + p).hidden = p !== proto; });
}
function loadSources() { loadMounts(); loadImportHistory(); }
async function doMount() {
  const btn = $('mountBtn'), status = $('mountStatus');
  const fail = (msg) => setStatus(status, msg, 'err');
  setStatus(status, '');
  const body = { protocol: currentProto };
  if (currentProto === 'smb') {
    body.host = $('smbHost').value.trim(); body.shareName = $('smbShare').value.trim();
    body.username = $('smbUser').value.trim(); body.password = $('smbPass').value; body.domain = $('smbDomain').value.trim();
    if (!body.host || !body.shareName) return fail('Enter the host and share name.');
  } else if (currentProto === 'nfs') {
    body.host = $('nfsHost').value.trim(); body.shareName = $('nfsExport').value.trim();
    if (!body.host || !body.shareName) return fail('Enter the host and export path.');
  } else {
    body.localPath = $('localPath').value.trim();
    if (!body.localPath) return fail('Enter a folder path on the server.');
  }
  const done = btnBusy(btn, 'Connecting…');
  setStatus(status, 'Connecting to ' + (body.host || body.localPath) + '…');
  try {
    const raw = await fetch('/api/aurora/mount', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const res = await raw.json().catch(() => ({ success: false, error: `Server error ${raw.status}` }));
    if (!res.success) { fail(res.error || 'Couldn’t connect'); done(); return; }
    useMount(res.mountPoint, true);
    setStatus(status, 'Connected. Scan & index it below.', 'ok');
    done('Connected');
    loadMounts();
    $('mountedSourceCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) { fail('Error: ' + err.message); done(); }
}
function clearMount() { mountedPath = null; $('mountedSourceCard').hidden = true; setStatus('mountStatus', ''); }
function useMount(p, quiet) {
  mountedPath = p;
  $('mountedPathDisplay').textContent = p;
  $('mountedSourceCard').hidden = false;
  if (!quiet) toast('Source set. Tap Scan & index to import.');
}
async function loadMounts() {
  const card = $('connectedSharesCard'), list = $('connectedSharesList'), rs = $('reindexSources');
  try {
    const { mounts } = await getJSON('/api/aurora/mounts');
    card.hidden = !(mounts && mounts.length);
    list.innerHTML = (mounts || []).map((m, i) => `
      <button type="button" class="row" data-i="${i}">
        <span class="share-badge">${escapeHtml(m.type || '?')}</span>
        <span class="row-label"><span class="mono-line">${escapeHtml(m.source)}</span><small class="mono-line">${escapeHtml(m.path)}${m.readOnly ? ' · read-only' : ''}</small></span>
        ${ic('chev', 'chev')}
      </button>`).join('');
    list.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const m = mounts[+b.dataset.i];
      openMenu(b, [
        { label: 'Scan this share', icon: 'refresh', onClick: () => { useMount(m.path, true); $('mountedSourceCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
        { label: 'Unmount', icon: 'x', danger: true, onClick: () => unmountMount(m.path, b) },
      ], { title: m.source });
    };
    rs.innerHTML = (mounts && mounts.length) ? mounts.map((m, i) => `
      <div class="row"><span class="share-badge">${escapeHtml(m.type || '?')}</span><span class="row-label mono-line">${escapeHtml(m.path)}</span>
        <button type="button" class="btn small gray" data-reindex="${i}">Re-index</button></div>`).join('')
      : '<div class="row muted">No shares mounted. Connect a source above first.</div>';
    rs.onclick = (e) => { const b = e.target.closest('[data-reindex]'); if (b) settingsReindex(mounts[+b.dataset.reindex].path, b); };
  } catch (_) { card.hidden = true; }
}
async function unmountMount(p, btn) {
  const ok = await uiConfirm({ title: 'Unmount this share?', message: p, ok: 'Unmount', danger: true });
  if (!ok) return;
  const done = btnBusy(btn, '…');
  try {
    await postJSON('/api/aurora/unmount', { mountPoint: p });
    toast('Unmounted');
    if (mountedPath === p) clearMount();
    loadMounts();
  } catch (e) { toast('Unmount failed: ' + e.message); done(); }
}
async function loadImportHistory() {
  const imp = $('settingsImports');
  try {
    const m = await getJSON('/api/aurora/settings/metrics');
    const recent = (m.imports && m.imports.recent) || [];
    imp.innerHTML = recent.length ? recent.map(s => {
      const cls = s.status === 'complete' ? 'ok' : s.status === 'error' ? 'err' : 'run';
      return `<div class="row static"><span class="share-badge ${cls}">${escapeHtml(s.status)}</span>
        <span class="row-label"><span class="mono-line">${escapeHtml(s.source_path)}</span>
        <small>${s.started_at ? fmtDate(s.started_at) : '—'} · ${(s.indexed || 0).toLocaleString()} indexed · ${(s.skipped || 0).toLocaleString()} skipped · ${s.errors || 0} errors</small></span></div>`;
    }).join('') : '<div class="row muted">No imports yet</div>';
  } catch (_) { imp.innerHTML = '<div class="row muted">Couldn’t load import history</div>'; }
}
function resetImportBtn() {
  const b = $('importBtn');
  if (b) { b.dataset.busy = '0'; b.disabled = false; b.innerHTML = b.dataset.origHtml || 'Scan &amp; index'; }
}
async function startImport() {
  const btn = $('importBtn');
  if (!mountedPath) { toast('Add a source first'); return; }
  const done = btnBusy(btn, 'Starting…');
  try {
    const raw = await fetch('/api/aurora/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourcePath: mountedPath }) });
    const res = await raw.json().catch(() => ({ error: `Server error ${raw.status}` }));
    if (res.error) { toast('Couldn’t start: ' + res.error); done(); return; }
    btn.innerHTML = '<span class="spin-dot"></span>Indexing…';
    monitorImport(res.sessionId);
  } catch (err) { toast('Import failed: ' + err.message); done(); }
}
// Streams progress for an import / re-index session and refreshes the Library
// in chunks while it runs, so the grid fills up during a long import.
function monitorImport(sessionId) {
  state.importSessionId = sessionId;
  $('importProgress').hidden = false;
  if (state.importSSE) state.importSSE.close();
  const es = new EventSource(`/api/aurora/import/progress/${sessionId}/stream`);
  state.importSSE = es;
  let lastIndexedSeen = 0, lastRefreshAt = 0, refreshInFlight = false;
  const maybeLiveRefresh = async (s) => {
    if (s.status !== 'indexing' && s.status !== 'scanning') return;
    if ((s.indexed || 0) - lastIndexedSeen < 100 || Date.now() - lastRefreshAt < 3000 || refreshInFlight) return;
    refreshInFlight = true; lastRefreshAt = Date.now(); lastIndexedSeen = s.indexed;
    try { await Promise.all([loadStats(), loadIndex()]); } catch (_) {}
    finally { refreshInFlight = false; }
  };
  es.onerror = () => {
    setTimeout(async () => {
      try {
        const final = await getJSON(`/api/aurora/import/progress/${sessionId}`);
        updateImportUI({ ...final, recentLog: final.log ? final.log.slice(-5) : [] });
        if (['complete', 'error', 'interrupted'].includes(final.status)) resetImportBtn();
      } catch (_) {}
    }, 500);
  };
  es.onmessage = (e) => {
    let s; try { s = JSON.parse(e.data); } catch (_) { return; }
    updateImportUI(s);
    maybeLiveRefresh(s);
    if (['complete', 'error', 'interrupted'].includes(s.status)) {
      es.close(); resetImportBtn(); loadStats(); loadIndex(); loadImportHistory();
    }
  };
}
function updateImportUI(s) {
  $('kpiScanned').textContent = (s.scanned || 0).toLocaleString();
  $('kpiIndexed').textContent = (s.indexed || 0).toLocaleString();
  $('kpiSkipped').textContent = (s.skipped || 0).toLocaleString();
  $('kpiErrors').textContent = (s.errors || 0).toLocaleString();
  const pct = s.scanned ? Math.round(((s.indexed || 0) + (s.skipped || 0)) / s.scanned * 100) : 0;
  $('progressBar').style.width = pct + '%';
  const stage = (id, cls, text) => { $(id).className = 'stage' + (cls ? ' ' + cls : ''); if (text != null) $(id + 'Status').textContent = text; };
  if (s.status === 'scanning') stage('stageScanning', 'active', 'Running…');
  else if (s.status === 'indexing') { stage('stageScanning', 'done', (s.scanned || 0).toLocaleString() + ' files'); stage('stageIndexing', 'active', pct + '%'); }
  else if (s.status === 'complete') {
    stage('stageScanning', 'done'); stage('stageIndexing', 'done', 'Complete'); stage('stageGeo', 'done', 'Complete');
    toast('Import complete — ' + (s.indexed || 0).toLocaleString() + ' items indexed');
  } else if (s.status === 'error' || s.status === 'interrupted') {
    stage('stageIndexing', '', s.status === 'interrupted' ? 'Interrupted — run again to resume' : 'Error');
    toast(s.status === 'interrupted' ? 'The import was interrupted. Run it again to resume.' : 'Import error. Check the log.');
  }
  const lines = s.recentLog || (s.log ? s.log.slice(-5) : []);
  if (lines.length) {
    const feed = $('logFeed');
    feed.innerHTML = lines.map(msg => `<div class="log-line">› ${escapeHtml(msg)}</div>`).join('');
    feed.scrollTop = feed.scrollHeight;
  }
}
async function settingsReindex(p, btn) {
  const done = btnBusy(btn, '…');
  try {
    const r = await postJSON('/api/aurora/import', { sourcePath: p, force: true });
    done('Started');
    monitorImport(r.sessionId);
    $('importProgress').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { toast('Couldn’t start: ' + e.message); done(); }
}

// ── Display ───────────────────────────────────────────────────────────────
function syncDisplaySettings() {
  $('toggleHideRaw').checked = state.hideRaw;
  $('toggleNoBlur').checked = document.documentElement.classList.contains('no-blur');
}
function setHideRaw(on) {
  state.hideRaw = !!on;
  try { localStorage.setItem('aurora_hideRaw', on ? '1' : '0'); } catch (_) {}
  loadIndex();
  placesLoadedAt = 0;
  toast(on ? 'RAW photos hidden' : 'RAW photos shown');
}
function setNoBlur(on) {
  document.documentElement.classList.toggle('no-blur', !!on);
  try { localStorage.setItem('aurora.noblur', on ? '1' : '0'); } catch (_) {}
}

// ── Tags ──────────────────────────────────────────────────────────────────
async function loadTagManager() {
  const el = $('tagManager');
  try {
    const tags = await getJSON('/api/aurora/tags');
    if (!tags.length) { el.innerHTML = '<div class="row muted">No tags yet. Add them from a photo’s Info or with Select in the Library.</div>'; return; }
    el.innerHTML = tags.map(t => `<button type="button" class="row" data-id="${t.id}" data-name="${escapeHtml(t.name)}">${ic('tag')}
      <span class="row-label">${escapeHtml(t.name)}</span><span class="val">${t.count.toLocaleString()}</span>${ic('chev', 'chev')}</button>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      const id = +b.dataset.id, name = b.dataset.name;
      openMenu(b, [
        { label: 'Show photos', icon: 'photo', onClick: () => { closeSettings(); openTagDetail({ id, name }); } },
        { label: 'Rename…', icon: 'edit', onClick: () => tagRename(id, name) },
        { sep: true },
        { label: 'Delete tag', icon: 'trash', danger: true, onClick: () => tagDelete(id, name) },
      ], { title: name });
    };
  } catch (_) { el.innerHTML = '<div class="row muted">Couldn’t load tags</div>'; }
}
async function tagRename(tagId, current) {
  const name = await uiPrompt({ title: 'Rename tag', message: 'Renaming onto an existing tag merges the two.', value: current, ok: 'Rename', maxlength: 80 });
  if (!name || name === current) return;
  try {
    const r = await postJSON('/api/aurora/tags/rename', { tagId, name });
    toast(r.merged ? `Merged into “${name}”` : `Renamed to “${name}”`);
    assetCache.clear(); collectionsDirty = true; discoverLoadedAt = 0;
  } catch (e) { toast('Rename failed: ' + e.message); }
  loadTagManager();
}
async function tagDelete(tagId, name) {
  const ok = await uiConfirm({ title: `Delete “${name}”?`, message: 'The tag is removed from every photo. The photos are kept.', ok: 'Delete', danger: true });
  if (!ok) return;
  try { await postJSON('/api/aurora/tags/delete', { tagId }); toast(`Deleted “${name}”`); assetCache.clear(); collectionsDirty = true; discoverLoadedAt = 0; }
  catch (e) { toast('Delete failed: ' + e.message); }
  loadTagManager();
}

// ── Photo descriptions (captions) ─────────────────────────────────────────
let _captionPoll = null, _capConfigLoaded = false;
function renderCaptionState(s) {
  const startBtn = $('capStartBtn'), stopBtn = $('capStopBtn');
  const running = !!s.running, stopping = s.phase === 'stopping';
  startBtn.hidden = running; stopBtn.hidden = !running;
  startBtn.disabled = stopping;
  startBtn.textContent = stopping ? 'Stopping…' : (s.captioned > 0 ? 'Resume' : 'Start');
  const total = s.total || 0, captioned = s.captioned || 0;
  const pct = total ? Math.round((captioned / total) * 100) : 0;
  $('capProgress').hidden = !total;
  $('capProgressBar').style.width = pct + '%';
  $('capProgressLabel').textContent = `${captioned.toLocaleString()} of ${total.toLocaleString()} described (${pct}%)` + (running && s.done ? ` · ${s.done.toLocaleString()} this run` : '');
  const phaseTxt = { running: 'Running…', starting: 'Starting…', stopping: 'Stopping…', paused: 'Paused while an import runs', complete: 'All photos described', stopped: 'Stopped', error: 'Error', idle: '' }[s.phase] || '';
  setStatus('capStatus', s.phase === 'error' ? 'Error: ' + (s.error || 'see the server log') : phaseTxt, s.phase === 'complete' ? 'ok' : s.phase === 'error' ? 'err' : '');
  const hasActivity = (s.last && s.last.assetId) || (s.log && s.log.length);
  $('capMonitor').hidden = !hasActivity;
  if (s.last && s.last.assetId) {
    const img = $('capLastThumb');
    if (img.getAttribute('data-id') !== String(s.last.assetId)) { img.src = thumbUrl(s.last.assetId); img.setAttribute('data-id', String(s.last.assetId)); }
    $('capLastCap').textContent = s.last.caption || '';
    $('capLastMeta').textContent = `#${s.last.assetId} · ${fmtRelative(s.last.at)}`;
  }
  $('capLog').innerHTML = (s.log || []).map(e => `<div class="row static">
      <img class="row-thumb" loading="lazy" alt="" src="${thumbUrl(e.assetId)}">
      <span class="row-label ${e.ok ? '' : (e.skipped ? 'skip' : 'err')}" title="${escapeHtml(e.ok ? e.caption : e.error)}">${escapeHtml(e.ok ? (e.caption || '') : ((e.skipped ? 'Skipped: ' : 'Failed: ') + (e.error || '')))}</span>
      <span class="val">${fmtRelative(e.at)}</span></div>`).join('');
}
async function loadCaptions() {
  if (!_capConfigLoaded) { await capLoadConfig(); _capConfigLoaded = true; }
  try { renderCaptionState(await getJSON('/api/aurora/captions/status')); } catch (_) {}
  if (_captionPoll) return;
  _captionPoll = setInterval(async () => { try { renderCaptionState(await getJSON('/api/aurora/captions/status')); } catch (_) {} }, 2500);
}
function stopCaptionPolling() { if (_captionPoll) { clearInterval(_captionPoll); _captionPoll = null; } }
async function capStart(btn) {
  btn.disabled = true;
  try { await postJSON('/api/aurora/captions/start', {}); } catch (e) { toast(e.message); }
  btn.disabled = false;
  loadCaptions();
}
async function capStop(btn) {
  btn.disabled = true;
  try { await postJSON('/api/aurora/captions/stop', {}); } catch (_) {}
  btn.disabled = false;
  try { renderCaptionState(await getJSON('/api/aurora/captions/status')); } catch (_) {}
}
function capFillModelSelect(models, selected) {
  const sel = $('capModel');
  const cur = selected || sel.value;
  const list = (models && models.length) ? [...models] : (cur ? [{ name: cur, vision: true }] : []);
  list.sort((a, b) => (b.vision === a.vision) ? 0 : (b.vision ? 1 : -1));
  sel.innerHTML = list.map(m => `<option value="${escapeHtml(m.name)}"${m.name === cur ? ' selected' : ''}>${escapeHtml(m.name)}${m.vision ? '' : ' (no vision)'}${m.params ? ' · ' + escapeHtml(m.params) : ''}</option>`).join('');
  if (cur && !list.some(m => m.name === cur)) sel.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>`);
}
async function capLoadConfig() {
  try {
    const cfg = await getJSON('/api/aurora/captions/config');
    $('capUrl').value = cfg.url || '';
    $('capConc').value = String(cfg.concurrency || 1);
    $('capStyle').innerHTML = (cfg.styles || []).map(st => `<option value="${escapeHtml(st.key)}"${st.key === cfg.style ? ' selected' : ''}>${escapeHtml(st.label)}</option>`).join('');
    capFillModelSelect(null, cfg.model);
    capTestConnection(null, true);
  } catch (_) {}
}
async function capTestConnection(btn, quiet) {
  const hint = $('capModelHint');
  const url = $('capUrl').value.trim();
  if (btn) btn.disabled = true;
  if (!quiet) { hint.textContent = 'Testing…'; hint.style.color = ''; }
  try {
    const r = await getJSON('/api/aurora/captions/models?url=' + encodeURIComponent(url));
    if (r.ok) {
      capFillModelSelect(r.models, $('capModel').value);
      hint.textContent = `Connected · ${r.models.length} models (${r.models.filter(m => m.vision).length} vision)`;
      hint.style.color = 'var(--green)';
    } else { hint.textContent = r.error || 'Unreachable'; hint.style.color = 'var(--red)'; }
  } catch (e) { hint.textContent = e.message || 'Failed'; hint.style.color = 'var(--red)'; }
  if (btn) btn.disabled = false;
}
async function capSaveConfig(btn) {
  btn.disabled = true;
  setStatus('capSaveStatus', 'Saving…');
  try {
    await postJSON('/api/aurora/captions/config', {
      url: $('capUrl').value.trim(), model: $('capModel').value, style: $('capStyle').value,
      concurrency: parseInt($('capConc').value, 10) || 1,
    });
    setStatus('capSaveStatus', 'Saved', 'ok');
  } catch (e) { setStatus('capSaveStatus', 'Couldn’t save: ' + e.message, 'err'); }
  btn.disabled = false;
  setTimeout(() => setStatus('capSaveStatus', ''), 2500);
}

// ── Duplicates ────────────────────────────────────────────────────────────
let _dupPoll = null;
async function startSimilarScan() {
  const btn = $('dupSimilarBtn');
  const done = btnBusy(btn, 'Scanning…');
  setStatus('dupSimilarStatus', 'Looking for re-encoded copies…');
  try {
    const r = await postJSON('/api/aurora/settings/duplicates/scan-similar', {});
    if (!r.removed) setStatus('dupSimilarStatus', 'No re-encoded copies found', 'ok');
    else { setStatus('dupSimilarStatus', `Hid ${plural(r.removed, 'copy', 'copies')} of ${plural(r.groups || 0, 'photo')}`, 'ok'); loadStats(); loadIndex(); }
  } catch (e) { setStatus('dupSimilarStatus', 'Scan failed: ' + e.message, 'err'); }
  done();
}
async function startDupScan() {
  const btn = $('dupScanBtn');
  const autoMode = (document.querySelector('input[name="dupMode"]:checked') || {}).value !== 'manual';
  const done = btnBusy(btn, 'Scanning…');
  setStatus('dupScanStatus', 'Starting…');
  $('dupProgress').hidden = false;
  $('dupGroupsCard').hidden = true;
  try {
    await postJSON('/api/aurora/settings/duplicates/scan', {});
    clearInterval(_dupPoll);
    _dupPoll = setInterval(async () => {
      try {
        const s = await getJSON('/api/aurora/settings/duplicates/status');
        const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
        $('dupProgressBar').style.width = pct + '%';
        $('dupProgressLabel').textContent = `${(s.done || 0).toLocaleString()} of ${(s.total || 0).toLocaleString()} files checked`;
        if (s.running) return;
        clearInterval(_dupPoll); _dupPoll = null;
        done();
        if (s.error) setStatus('dupScanStatus', 'Error: ' + s.error, 'err');
        else if (!s.groups) setStatus('dupScanStatus', 'No duplicates found', 'ok');
        else if (autoMode) {
          setStatus('dupScanStatus', `Found ${s.groups} groups — resolving…`);
          try {
            const r = await postJSON('/api/aurora/settings/duplicates/resolve-all', {});
            setStatus('dupScanStatus', `Hid ${(r.removed || 0).toLocaleString()} duplicates across ${(r.groups || 0).toLocaleString()} groups`, 'ok');
            $('dupProgressBar').style.width = '100%';
            loadIndex();
          } catch (_) { setStatus('dupScanStatus', 'Scan finished but resolving failed', 'err'); }
        } else {
          setStatus('dupScanStatus', `Found ${plural(s.groups, 'group')} to review below`);
          loadDupGroups();
        }
      } catch (_) {}
    }, 1200);
  } catch (e) { setStatus('dupScanStatus', 'Error: ' + e.message, 'err'); done(); }
}
async function loadDupGroups() {
  const card = $('dupGroupsCard'), el = $('dupGroups');
  try {
    const groups = await getJSON('/api/aurora/settings/duplicates');
    card.hidden = !groups.length;
    el.innerHTML = '';
    for (const g of groups) {
      const div = document.createElement('div');
      div.className = 'dup-group';
      div.innerHTML = `<div class="dup-group-hdr">${g.count} identical copies</div><div class="dup-thumbs"></div>`;
      const row = div.querySelector('.dup-thumbs');
      g.assets.forEach((a) => {
        const item = document.createElement('div');
        item.className = 'dup-item';
        item.innerHTML = `<img class="dup-thumb" alt="" loading="lazy" src="${thumbUrl(a.id)}">
          <div class="dup-fname" title="${escapeHtml(a.path)}">${escapeHtml(a.path.split('/').pop())}</div>
          <div class="dup-fsize">${a.bytes ? fmtBytes(a.bytes) : '—'}</div>
          <button type="button" class="btn small" data-perm="photos.delete">Keep</button>`;
        item.querySelector('img').addEventListener('click', () => openLightboxWith(g.assets, g.assets.indexOf(a)));
        item.querySelector('button').addEventListener('click', () => resolveDup(g.assets.map(x => x.id), a.id, div));
        row.appendChild(item);
      });
      el.appendChild(div);
    }
    applyPermissionsToUI(el);
  } catch (_) { el.innerHTML = '<p class="group-foot">Couldn’t load duplicate groups</p>'; card.hidden = false; }
}
async function resolveDup(allIds, keepId, groupEl) {
  const removeIds = allIds.filter(id => id !== keepId);
  try {
    await postJSON('/api/aurora/settings/duplicates/resolve', { keepId, removeIds });
    groupEl.innerHTML = `<div class="dup-done">Resolved — ${plural(removeIds.length, 'copy', 'copies')} hidden</div>`;
    loadIndex();
  } catch (_) { toast('Couldn’t resolve the duplicates'); }
}

// ── Hidden album passcode ─────────────────────────────────────────────────
async function changePasscode() {
  const np = ($('newPasscode').value || '').trim(), cp = ($('confirmPasscode').value || '').trim();
  if (!np) return setStatus('passcodeSetStatus', 'Enter a new passcode', 'err');
  if (np !== cp) return setStatus('passcodeSetStatus', 'The passcodes don’t match', 'err');
  try {
    await postJSON('/api/aurora/settings/passcode/set', { passcode: np });
    setStatus('passcodeSetStatus', 'Passcode updated', 'ok');
    $('newPasscode').value = ''; $('confirmPasscode').value = '';
    setTimeout(() => setStatus('passcodeSetStatus', ''), 3000);
  } catch (e) { setStatus('passcodeSetStatus', 'Couldn’t save: ' + e.message, 'err'); }
}
async function loadPrivacyStats() {
  const el = $('privacyStats');
  try {
    const s = await getJSON('/api/aurora/settings/privacy/stats');
    el.innerHTML = `<div class="row static"><span class="row-label">Hidden photos</span><span class="val">${(s.hidden || 0).toLocaleString()}</span></div>
      <div class="row static"><span class="row-label">Duplicates hidden</span><span class="val">${(s.duplicates_hidden || 0).toLocaleString()}</span></div>`;
  } catch (_) { el.innerHTML = '<div class="row muted">—</div>'; }
}

// ── Maintenance ───────────────────────────────────────────────────────────
async function settingsWarm(btn) {
  const done = btnBusy(btn, 'Starting…');
  try { await postJSON('/api/aurora/warm', {}); setActionStatus('Thumbnail warming started in the background.', 'ok'); done('Started'); startWarmPoll(); }
  catch (e) { setActionStatus('Failed: ' + e.message, 'err'); done(); }
}
async function settingsWarmStop(btn) {
  const done = btnBusy(btn, 'Stopping…');
  try { await postJSON('/api/aurora/warm/stop', {}); setActionStatus('Warming is winding down…', 'ok'); done(); startWarmPoll(); }
  catch (e) { setActionStatus('Failed: ' + e.message, 'err'); done(); }
}
async function settingsWarmBootPref(chk) {
  try {
    const r = await postJSON('/api/aurora/warm/config', { warmOnBoot: chk.checked });
    toast(r.warmOnBoot ? 'Warming will start after each restart' : 'Warming after restarts is off');
  } catch (_) { toast('Couldn’t save'); chk.checked = !chk.checked; }
}
let warmPollTimer = null;
async function refreshWarmStatus() {
  try {
    const w = await getJSON('/api/aurora/warm/status');
    const line = $('warmProgressLine'), stopBtn = $('btnWarmStop'), chk = $('warmOnBootChk');
    if (chk && typeof w.warmOnBoot === 'boolean') chk.checked = w.warmOnBoot;
    if (w.running) {
      stopBtn.hidden = false; line.hidden = false;
      const pct = w.total ? Math.round((w.done / w.total) * 100) : 0;
      line.textContent = `Warming (${w.phase}): ${w.done.toLocaleString()} of ${w.total.toLocaleString()} checked (${pct}%) · ${w.generated.toLocaleString()} made this run`;
      return true;
    }
    stopBtn.hidden = true;
    if (w.phase === 'stopped') { line.hidden = false; line.textContent = `Stopped after making ${w.generated.toLocaleString()}. Start again any time; it resumes where it left off.`; }
    else if (w.phase === 'complete') { line.hidden = false; line.textContent = `Complete — ${w.generated.toLocaleString()} made in the last run.`; }
    else line.hidden = true;
    return false;
  } catch (_) { return false; }
}
function startWarmPoll() {
  stopWarmPoll();
  warmPollTimer = setInterval(async () => {
    if (state.screen !== 'settings') { stopWarmPoll(); return; }
    if (!(await refreshWarmStatus())) stopWarmPoll();
  }, 2500);
  refreshWarmStatus();
}
function stopWarmPoll() { if (warmPollTimer) { clearInterval(warmPollTimer); warmPollTimer = null; } }
async function settingsRelink(btn) {
  const done = btnBusy(btn, 'Re-linking…');
  setActionStatus('Re-linking Live Photos…');
  try {
    const r = await postJSON('/api/aurora/settings/relink-live', {});
    const bits = [];
    if (r.cleared > 0) bits.push(`unlinked ${r.cleared.toLocaleString()} stale pair${r.cleared === 1 ? '' : 's'}`);
    if (r.rejectedByTime > 0) bits.push(`skipped ${r.rejectedByTime.toLocaleString()} with mismatched times`);
    setActionStatus(`Linked ${(r.linked || 0).toLocaleString()} Live Photos.` + (bits.length ? ' (' + bits.join(', ') + ')' : ''), 'ok');
    done('Done');
    loadStats(); loadIndex();
  } catch (e) { setActionStatus('Failed: ' + e.message, 'err'); done(); }
}
async function settingsGeocode(btn) {
  const done = btnBusy(btn, 'Naming places…');
  setActionStatus('Naming places from the offline cities dataset…');
  try {
    const r = await postJSON('/api/aurora/settings/geocode-places', {});
    setActionStatus(`Named ${(r.named || 0).toLocaleString()} of ${(r.processed || 0).toLocaleString()} places.`, 'ok');
    done('Done');
    placesLoadedAt = 0;
    loadStats();
  } catch (e) { setActionStatus('Failed: ' + e.message, 'err'); done(); }
}

// ── Software update (GitHub releases) ─────────────────────────────────────
// Check → "Update now" downloads the release's update zip and hands it to the
// server-side applier (snapshot + DB backup, swaps code, npm install, restart,
// automatic rollback on failure). Progress polls /settings/update/status and
// the page hard-reloads onto the new build when it completes.
let updatePoller = null, updateLatest = null;
async function loadUpdateVersion() {
  try {
    const v = await getJSON('/api/aurora/version');
    $('updateVersionLine').textContent = `Aurora ${v.version} · build ${v.build || '—'}`;
    $('settingsVersionTag').textContent = v.version;
  } catch (_) {}
}
function setUpdateStatus(msg, kind) {
  const el = $('updateStatus');
  el.textContent = msg;
  el.className = 'update-status visible ' + (kind || 'info');
}
function mdEscape(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
// Tiny Markdown renderer for release notes: headings, bullets, bold/italic, code, links.
function renderChangelog(md) {
  if (!md) return '<em>No release notes provided.</em>';
  const out = [];
  let inList = false;
  const inline = (t) => mdEscape(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  for (const raw of String(md).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.+)$/), li = line.match(/^\s*[-*]\s+(.+)$/);
    if (h) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h4 style="margin:10px 0 4px;font-size:${17 - h[1].length}px">${inline(h[2])}</h4>`); }
    else if (li) { if (!inList) { out.push('<ul style="margin:6px 0 6px 20px;padding:0">'); inList = true; } out.push(`<li style="margin-bottom:3px">${inline(li[1])}</li>`); }
    else if (!line) { if (inList) { out.push('</ul>'); inList = false; } out.push('<div style="height:6px"></div>'); }
    else { if (inList) { out.push('</ul>'); inList = false; } out.push(`<div>${inline(line)}</div>`); }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}
async function checkForUpdates() {
  const btn = $('updateCheckBtn'), summary = $('updateSummary'), statusLine = $('updateCheckStatus');
  const applyBtn = $('updateApplyBtn'), linkBtn = $('updateReleaseLink'), clWrap = $('updateChangelogWrap');
  btn.disabled = true;
  summary.className = 'update-summary';
  statusLine.textContent = 'Checking GitHub for the latest release…';
  applyBtn.hidden = true; linkBtn.hidden = true; clWrap.hidden = true;
  try {
    const r = await fetch('/api/aurora/settings/update/check');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Check failed');
    updateLatest = data.latest;
    const curV = (data.current && data.current.version) || '?', latV = (data.latest && data.latest.version) || '?';
    if (data.updateAvailable && data.assetAvailable) {
      summary.className = 'update-summary available';
      statusLine.innerHTML = `Aurora ${escapeHtml(latV)} is available <span class="badge new">NEW</span>` +
        `<div class="update-detail">You have ${escapeHtml(curV)}` +
        (data.latest.assetSize ? ` · ${(data.latest.assetSize / 1024 / 1024).toFixed(1)} MB download` : '') +
        (data.latest.publishedAt ? ` · published ${fmtDate(new Date(data.latest.publishedAt).getTime())}` : '') + '</div>';
      applyBtn.hidden = false; applyBtn.disabled = false;
    } else if (data.updateAvailable && !data.assetAvailable) {
      summary.className = 'update-summary err';
      statusLine.innerHTML = `Aurora ${escapeHtml(latV)} is out, but its update file isn’t ready yet. Try again in a few minutes, or install from a local zip below.`;
    } else {
      summary.className = 'update-summary uptodate';
      statusLine.innerHTML = `Aurora is up to date <span class="badge ok">${escapeHtml(curV)}</span><div class="update-detail">Latest release: ${escapeHtml(latV)}</div>`;
    }
    if (data.latest && data.latest.htmlUrl) { linkBtn.href = data.latest.htmlUrl; linkBtn.hidden = false; }
    if (data.latest && data.latest.changelog) {
      $('updateChangelog').innerHTML = renderChangelog(data.latest.changelog);
      clWrap.hidden = false;
      if (data.updateAvailable) clWrap.open = true;
    }
  } catch (e) {
    summary.className = 'update-summary err';
    statusLine.textContent = 'Couldn’t check for updates: ' + e.message;
  } finally { btn.disabled = false; }
}
async function applyGitHubUpdate() {
  if (!updateLatest) return;
  const ok = await uiConfirm({
    title: `Install Aurora ${updateLatest.version}?`,
    message: 'Aurora restarts during the update. Your library and settings are kept, and a rollback snapshot is taken first so a failed update reverts automatically.',
    ok: 'Install',
  });
  if (!ok) return;
  const btn = $('updateApplyBtn');
  btn.disabled = true;
  setUpdateStatus('Downloading the update from GitHub…', 'info');
  try {
    const r = await fetch('/api/aurora/settings/update/apply-github', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await r.json();
    if (!r.ok) { setUpdateStatus('Error: ' + (data.error || 'Update failed'), 'err'); btn.disabled = false; return; }
    setUpdateStatus(data.message || 'Update started…', 'info');
    startUpdatePoller();
  } catch (e) { setUpdateStatus('Request failed: ' + e.message, 'err'); btn.disabled = false; }
}
async function applyUpdate() {
  const zipPath = ($('updateZipPath').value || '').trim();
  if (!zipPath) { setUpdateStatus('Enter the full path to the update zip.', 'err'); return; }
  const btn = $('updateApplyLocalBtn');
  btn.disabled = true;
  setUpdateStatus('Sending the update request…', 'info');
  try {
    const r = await postJSON('/api/aurora/settings/update/apply', { zipPath });
    setUpdateStatus(r.message || 'Update started…', 'info');
    startUpdatePoller();
  } catch (e) { setUpdateStatus('Error: ' + e.message, 'err'); btn.disabled = false; }
}
function startUpdatePoller() {
  if (updatePoller) clearInterval(updatePoller);
  const enable = () => { $('updateApplyBtn').disabled = false; $('updateApplyLocalBtn').disabled = false; };
  updatePoller = setInterval(async () => {
    try {
      const s = await getJSON('/api/aurora/settings/update/status');
      const msg = s.message || s.status || '';
      if (s.status === 'complete') {
        clearInterval(updatePoller); updatePoller = null;
        setUpdateStatus(msg + ' — reloading…', 'ok');
        enable();
        // hardReload drops every cache + the service worker first, so the new
        // build actually loads (a plain reload could keep the old shell).
        setTimeout(() => hardReload(), 1500);
      } else if (s.status === 'error' || s.status === 'rolled_back') {
        clearInterval(updatePoller); updatePoller = null;
        setUpdateStatus(msg, 'err');
        enable();
      } else if (s.status !== 'idle') setUpdateStatus(msg || 'Updating…', 'info');
    } catch (_) {
      // The server is down mid-restart — keep polling quietly.
      setUpdateStatus('Waiting for Aurora to come back…', 'info');
    }
  }, 1500);
}
// If the page loads during an update (e.g. after a refresh), keep following it.
function checkPendingUpdate() {
  if (!havePerm('settings.view')) return;
  getJSON('/api/aurora/settings/update/status').then(s => {
    if (s.status && !['idle', 'complete', 'error', 'rolled_back'].includes(s.status)) {
      setUpdateStatus(s.message || 'Update in progress…', 'info');
      startUpdatePoller();
    }
  }).catch(() => {});
}
