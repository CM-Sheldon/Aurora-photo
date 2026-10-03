/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — admin.js
   Signed-in user (/me), the account sheet (theme, icon, PIN, sign out), and
   the admin pages: Users (list + detail), Roles, Activity log. Dialog forms
   use the #rbacOverlay surface; the server enforces every permission.
   ════════════════════════════════════════════════════════════════════════ */

async function loadMe() {
  try {
    const r = await fetch('/api/aurora/auth/me');
    if (!r.ok) return;
    window.AURORA_ME = await r.json();
    applyTheme(window.AURORA_ME.theme || 'purple');
    applyPermissionsToUI();
    renderAvatarButtons();
    // An admin reset (or a brand-new account) must pick its own PIN first.
    if (window.AURORA_ME.mustChangePin) openChangePinDialog({ forced: true });
  } catch (_) {}
  finally {
    // Always drop the pre-load cloak, even if /me failed.
    document.body.classList.add('perms-ready');
  }
}

// ── Avatar + account sheet ────────────────────────────────────────────────
function avatarGlyph(a) { return (a && String(a).trim()) || '👤'; }
const AVATAR_CHOICES = ['👤', '😀', '😎', '🦊', '🐱', '🐶', '🐼', '🦉', '🌸', '🌟', '🔥', '🌊', '🏔', '📷', '🎸', '⚽', '🚀', '👑', '🦄', '🍀', '🎨', '☕', '🐢', '🌈'];
function renderAvatarButtons() {
  const me = window.AURORA_ME;
  if (!me) return;
  const glyph = avatarGlyph(me.avatar);
  document.querySelectorAll('[data-avatar-glyph]').forEach(el => { el.textContent = glyph; });
  document.querySelectorAll('[data-avatar-name]').forEach(el => { el.textContent = me.username; });
  document.querySelectorAll('.avatar-btn').forEach(b => { b.title = `Signed in as ${me.username} (${me.role})`; });
  $('acctRole').textContent = me.role;
  document.querySelectorAll('[data-theme-opt]').forEach(b => b.classList.toggle('on', b.dataset.themeOpt === (me.theme || 'purple')));
}
function openAccountSheet() {
  closeMenus();
  renderAvatarButtons();
  $('acctVersion').textContent = `Aurora ${PAGE_VERSION}`;
  showStaticSheet($('accountSheet'));
}
function closeAccountSheet() { hideStaticSheet($('accountSheet')); }
async function setMyTheme(theme) {
  if (!THEMES.includes(theme)) return;
  applyTheme(theme);
  if (window.AURORA_ME) window.AURORA_ME.theme = theme;
  renderAvatarButtons();
  try { await postJSON('/api/aurora/auth/prefs', { theme }); } catch (_) {}
}
function openMyAvatarDialog() {
  closeAccountSheet();
  const cur = (window.AURORA_ME || {}).avatar || '';
  openRbacDialog(`
    <h3>Choose your icon</h3>
    <div class="av-grid">${AVATAR_CHOICES.map(g => `<button type="button" class="av-choice${(g === '👤' ? !cur : g === cur) ? ' on' : ''}" onclick="pickMyAvatar('${g}')">${g}</button>`).join('')}</div>
    <p class="hint">Shown next to your name across Aurora.</p>
    <div class="dialog-actions"><button type="button" class="dbtn" onclick="closeRbacDialog()">Close</button></div>`);
}
async function pickMyAvatar(glyph) {
  const avatar = glyph === '👤' ? '' : glyph;
  if (window.AURORA_ME) window.AURORA_ME.avatar = avatar;
  renderAvatarButtons();
  closeRbacDialog();
  try { await postJSON('/api/aurora/auth/prefs', { avatar }); } catch (_) {}
}
async function doLogout() {
  try { await fetch('/api/aurora/auth/logout', { method: 'POST' }); } catch (_) {}
  location.replace('/login');
}

// ── Change PIN (also the forced first-sign-in flow) ───────────────────────
function pinField(id, label, auto) {
  return `<label class="field-label" for="${id}">${label}</label>
    <input type="password" id="${id}" class="pin-input" maxlength="4" inputmode="numeric" pattern="\\d{4}" autocomplete="${auto}">`;
}
function openChangePinDialog(opts) {
  const forced = !!(opts && opts.forced);
  closeAccountSheet();
  openRbacDialog(`
    <h3>${forced ? 'Choose a new PIN' : 'Change PIN'}</h3>
    ${forced ? '<p class="hint" style="margin-top:0">An administrator reset your PIN. Pick a new 4-digit PIN to continue.</p>' : ''}
    ${pinField('cp_old', forced ? 'Temporary PIN (from your admin)' : 'Current PIN', 'current-password')}
    ${pinField('cp_new', 'New 4-digit PIN', 'new-password')}
    ${pinField('cp_new2', 'Confirm new PIN', 'new-password')}
    <div class="err" id="rd_err"></div>
    <div class="dialog-actions">
      ${forced ? '' : '<button type="button" class="dbtn" onclick="closeRbacDialog()">Cancel</button>'}
      <button type="button" class="dbtn strong" id="cp_submit" onclick="submitChangePin()">${forced ? 'Set PIN' : 'Update PIN'}</button>
    </div>`, { forced });
  ['cp_old', 'cp_new', 'cp_new2'].forEach(id => {
    const el = $(id);
    el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, '').slice(0, 4); });
  });
  setTimeout(() => $('cp_old').focus(), 40);
}
async function submitChangePin() {
  const oldPin = $('cp_old').value, newPin = $('cp_new').value, newPin2 = $('cp_new2').value;
  if (!/^\d{4}$/.test(newPin)) return showRbacErr('The new PIN must be 4 digits');
  if (newPin !== newPin2) return showRbacErr('The new PINs don’t match');
  if (newPin === oldPin) return showRbacErr('The new PIN must be different');
  const btn = $('cp_submit');
  btn.disabled = true;
  try {
    const r = await fetch('/api/aurora/auth/change-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPin: oldPin, newPin }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { showRbacErr(b.error || 'Failed'); btn.disabled = false; return; }
    if (window.AURORA_ME) window.AURORA_ME.mustChangePin = false;
    $('rbacOverlay').dataset.forced = '';
    closeRbacDialog();
    toast('PIN updated — other devices were signed out');
  } catch (e) { showRbacErr(e.message || 'Failed'); btn.disabled = false; }
}

// ── RBAC dialog surface ───────────────────────────────────────────────────
function openRbacDialog(html, opts) {
  const ov = $('rbacOverlay');
  ov.dataset.forced = opts && opts.forced ? '1' : '';
  $('rbacDialog').innerHTML = html;
  ov.hidden = false;
}
function closeRbacDialog() {
  const ov = $('rbacOverlay');
  if (ov.dataset.forced) return;
  ov.hidden = true;
  $('rbacDialog').innerHTML = '';
}
function showRbacErr(msg) { const el = $('rd_err'); if (el) { el.textContent = msg; el.classList.add('show'); } }

// ── Users ─────────────────────────────────────────────────────────────────
let _usersCache = [], _rolesCache = [], _userDetailId = null;
async function fetchUsersAndRoles() {
  const [u, r] = await Promise.all([
    getJSON('/api/aurora/auth/admin/users'),
    havePerm('roles.manage') ? getJSON('/api/aurora/auth/admin/roles') : Promise.resolve({ roles: [] }),
  ]);
  _usersCache = u.users || [];
  _rolesCache = r.roles || [];
}
async function loadUsers() {
  const list = $('usersList');
  try {
    await fetchUsersAndRoles();
    $('sUsersVal').textContent = _usersCache.length;
    list.innerHTML = _usersCache.map(u => `
      <button type="button" class="row user-row" data-id="${u.id}">
        <span class="avatar-glyph">${escapeHtml(avatarGlyph(u.avatar))}</span>
        <span class="row-label">${escapeHtml(u.username)}<small>${escapeHtml(u.role_name)} · ${u.last_seen_at ? 'last seen ' + fmtRelative(u.last_seen_at) : 'never signed in'}</small></span>
        ${u.disabled ? '<span class="role-badge disabled">Disabled</span>' : ''}
        ${ic('chev', 'chev')}
      </button>`).join('') || '<div class="row muted">No users yet</div>';
    list.onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) openUserDetail(+b.dataset.id); };
    if (_userDetailId && settingsNav.stack.includes('user')) renderUserDetail();
  } catch (e) { list.innerHTML = `<div class="row muted">Couldn’t load users: ${escapeHtml(e.message)}</div>`; }
}
function openUserDetail(id) {
  _userDetailId = id;
  renderUserDetail();
  openSettingsPage('user');
}
function renderUserDetail() {
  const u = _usersCache.find(x => x.id === _userDetailId);
  const host = $('userDetail');
  if (!u) { host.innerHTML = '<p class="group-foot">This user no longer exists.</p>'; return; }
  const me = window.AURORA_ME && window.AURORA_ME.userId === u.id;
  const roleOpts = (_rolesCache.length ? _rolesCache.map(r => r.name) : [u.role_name])
    .map(n => `<option value="${escapeHtml(n)}"${n === u.role_name ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
  host.innerHTML = `
    <div class="user-hero"><div class="acct-avatar">${escapeHtml(avatarGlyph(u.avatar))}</div>
      <h2>${escapeHtml(u.username)}</h2><p>${u.last_seen_at ? 'Last seen ' + fmtDateTime(u.last_seen_at) : 'Never signed in'}${me ? ' · This is you' : ''}</p></div>
    <div class="group">
      <label class="row"><span class="row-label">Role</span>
        <select class="inline-select" id="udRole" ${havePerm('roles.manage') || _rolesCache.length ? '' : 'disabled'}>${roleOpts}</select>${ic('down', 'chev')}</label>
      <button type="button" class="row" id="udEdit">${ic('edit')}<span class="row-label">Name &amp; icon</span>${ic('chev', 'chev')}</button>
      <button type="button" class="row" id="udPin">${ic('key')}<span class="row-label">Reset PIN</span>${ic('chev', 'chev')}</button>
    </div>
    <div class="group"><button type="button" class="row" id="udDisable">${ic(u.disabled ? 'unlock' : 'lock')}<span class="row-label">${u.disabled ? 'Allow sign-in' : 'Block sign-in'}</span></button></div>
    <div class="group"><button type="button" class="row danger center" id="udDelete"><span class="row-label">Delete user</span></button></div>`;
  $('udRole').addEventListener('change', (e) => setUserRole(u.id, e.target.value));
  $('udEdit').addEventListener('click', () => openUserEditDialog(u.id));
  $('udPin').addEventListener('click', () => resetUserPin(u.id, u.username));
  $('udDisable').addEventListener('click', () => toggleUserDisabled(u.id, u.disabled ? 0 : 1));
  $('udDelete').addEventListener('click', () => deleteUser(u.id, u.username));
}
async function setUserRole(id, role) {
  try { await postJSON(`/api/aurora/auth/admin/users/${id}/role`, { role }); toast('Role updated'); }
  catch (e) { toast(e.message); }
  loadUsers();
}
async function toggleUserDisabled(id, disabled) {
  try { await postJSON(`/api/aurora/auth/admin/users/${id}/disabled`, { disabled: !!disabled }); toast(disabled ? 'Sign-in blocked' : 'Sign-in allowed'); }
  catch (e) { toast(e.message); }
  loadUsers();
}
async function deleteUser(id, name) {
  const ok = await uiConfirm({ title: `Delete ${name}?`, message: 'This can’t be undone. Their photos and albums are not affected.', ok: 'Delete', danger: true });
  if (!ok) return;
  try {
    const r = await fetch('/api/aurora/auth/admin/users/' + id, { method: 'DELETE' });
    if (!r.ok) { const b = await r.json().catch(() => ({})); toast(b.error || 'Failed'); return; }
    toast('User deleted');
    _userDetailId = null;
    settingsBack();
    loadUsers();
  } catch (e) { toast(e.message); }
}
function resetUserPin(id, name) {
  openRbacDialog(`
    <h3>Reset PIN for ${escapeHtml(name)}</h3>
    ${pinField('rd_pin', 'Temporary 4-digit PIN', 'new-password')}
    <p class="hint">They’ll be asked to choose their own PIN the next time they sign in.</p>
    <div class="err" id="rd_err"></div>
    <div class="dialog-actions"><button type="button" class="dbtn" onclick="closeRbacDialog()">Cancel</button><button type="button" class="dbtn strong" onclick="submitResetPin(${id})">Reset</button></div>`);
  setTimeout(() => $('rd_pin').focus(), 40);
}
async function submitResetPin(id) {
  try {
    await postJSON(`/api/aurora/auth/admin/users/${id}/pin`, { pin: $('rd_pin').value });
    closeRbacDialog();
    toast('PIN reset — their other sessions were signed out');
    loadUsers();
  } catch (e) { showRbacErr(e.message); }
}
async function openUserAddDialog() {
  try { if (!_rolesCache.length && havePerm('roles.manage')) await fetchUsersAndRoles(); } catch (_) {}
  const roles = _rolesCache.length ? _rolesCache.map(r => r.name) : ['user'];
  openRbacDialog(`
    <h3>Add user</h3>
    <label class="field-label" for="rd_user">Username</label><input type="text" id="rd_user" autocomplete="off" spellcheck="false" autocapitalize="off">
    ${pinField('rd_pin', 'Temporary 4-digit PIN', 'new-password')}
    <label class="field-label" for="rd_role">Role</label>
    <select id="rd_role">${roles.map(n => `<option value="${escapeHtml(n)}"${n === 'user' ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select>
    <p class="hint">They’ll choose their own PIN the first time they sign in.</p>
    <div class="err" id="rd_err"></div>
    <div class="dialog-actions"><button type="button" class="dbtn" onclick="closeRbacDialog()">Cancel</button><button type="button" class="dbtn strong" onclick="submitAddUser()">Create</button></div>`);
  setTimeout(() => $('rd_user').focus(), 40);
}
async function submitAddUser() {
  try {
    await postJSON('/api/aurora/auth/admin/users', { username: $('rd_user').value.trim(), pin: $('rd_pin').value, role: $('rd_role').value });
    closeRbacDialog();
    toast('User created');
    loadUsers();
  } catch (e) { showRbacErr(e.message); }
}
let _editUserAvatar = '';
function openUserEditDialog(id) {
  const u = _usersCache.find(x => x.id === id);
  if (!u) return;
  _editUserAvatar = u.avatar || '';
  openRbacDialog(`
    <h3>Name &amp; icon</h3>
    <label class="field-label" for="ue_name">Username</label>
    <input type="text" id="ue_name" autocomplete="off" spellcheck="false" autocapitalize="off" value="${escapeHtml(u.username)}">
    <label class="field-label">Icon</label>
    <div class="av-grid" id="ue_avgrid">${AVATAR_CHOICES.map(g => `<button type="button" class="av-choice${(g === '👤' ? !_editUserAvatar : g === _editUserAvatar) ? ' on' : ''}" data-glyph="${g}">${g}</button>`).join('')}</div>
    <div class="err" id="rd_err"></div>
    <div class="dialog-actions"><button type="button" class="dbtn" onclick="closeRbacDialog()">Cancel</button><button type="button" class="dbtn strong" onclick="submitUserProfile(${id})">Save</button></div>`);
  $('ue_avgrid').addEventListener('click', (e) => {
    const b = e.target.closest('.av-choice');
    if (!b) return;
    _editUserAvatar = b.dataset.glyph === '👤' ? '' : b.dataset.glyph;
    $('ue_avgrid').querySelectorAll('.av-choice').forEach(x => x.classList.toggle('on', x === b));
  });
}
async function submitUserProfile(id) {
  const username = $('ue_name').value.trim();
  try {
    await postJSON(`/api/aurora/auth/admin/users/${id}/profile`, { username, avatar: _editUserAvatar });
    closeRbacDialog();
    toast('Saved');
    if (window.AURORA_ME && window.AURORA_ME.userId === id) {
      window.AURORA_ME.username = username;
      window.AURORA_ME.avatar = _editUserAvatar;
      renderAvatarButtons();
    }
    loadUsers();
  } catch (e) { showRbacErr(e.message); }
}

// ── Roles ─────────────────────────────────────────────────────────────────
async function loadRoles() {
  const list = $('rolesList');
  try {
    const { roles } = await getJSON('/api/aurora/auth/admin/roles');
    _rolesCache = roles;
    list.innerHTML = roles.map(r => {
      const perms = r.name === 'admin' ? 'Every permission' : (r.permissions && r.permissions.length ? r.permissions.length + ' permissions' : 'No permissions');
      return `<button type="button" class="row" data-id="${r.id}" data-name="${escapeHtml(r.name)}">
        <span class="row-label">${escapeHtml(r.name)}<small>${r.is_builtin ? 'Built-in' : 'Custom'} · ${perms}</small></span>
        ${r.name === 'admin' ? '<span class="role-badge admin">Admin</span>' : ''}${ic('chev', 'chev')}</button>`;
    }).join('');
    list.onclick = (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      const role = roles.find(x => x.id === +b.dataset.id);
      if (role && role.is_builtin && role.name === 'admin') { uiAlert('Admin role', 'The admin role always has every permission, so it can’t be edited.'); return; }
      openMenu(b, [
        { label: 'Edit permissions', icon: 'edit', onClick: () => openRoleDialog(role.id) },
        { label: 'Delete role', icon: 'trash', danger: true, hidden: role.is_builtin, onClick: () => deleteRole(role.id, role.name) },
      ], { title: role.name });
    };
  } catch (e) { list.innerHTML = `<div class="row muted">Couldn’t load roles: ${escapeHtml(e.message)}</div>`; }
}
async function deleteRole(id, name) {
  const ok = await uiConfirm({ title: `Delete the ${name} role?`, ok: 'Delete', danger: true });
  if (!ok) return;
  try {
    const r = await fetch('/api/aurora/auth/admin/roles/' + id, { method: 'DELETE' });
    if (!r.ok) { const b = await r.json().catch(() => ({})); toast(b.error || 'Failed'); return; }
    loadRoles();
  } catch (e) { toast(e.message); }
}
async function openRoleDialog(id) {
  try {
    const { roles, catalog } = await getJSON('/api/aurora/auth/admin/roles');
    const existing = id ? roles.find(r => r.id === id) : null;
    const groups = {};
    catalog.forEach(p => { (groups[p.group] = groups[p.group] || []).push(p); });
    const permsHtml = Object.keys(groups).map(g => `
      <div class="perm-group"><h4>${escapeHtml(g)}</h4><div class="perm-list">
        ${groups[g].map(p => `<label><input type="checkbox" data-perm-key="${escapeHtml(p.key)}"${existing && existing.permissions.indexOf(p.key) >= 0 ? ' checked' : ''}>
          <span>${escapeHtml(p.label)}<span class="desc">${escapeHtml(p.key)}</span></span></label>`).join('')}
      </div></div>`).join('');
    openRbacDialog(`
      <h3>${existing ? 'Role: ' + escapeHtml(existing.name) : 'New role'}</h3>
      ${existing ? '' : '<label class="field-label" for="rd_name">Name</label><input type="text" id="rd_name" autocomplete="off">'}
      ${permsHtml}
      <div class="err" id="rd_err"></div>
      <div class="dialog-actions"><button type="button" class="dbtn" onclick="closeRbacDialog()">Cancel</button>
        <button type="button" class="dbtn strong" onclick="submitRole(${existing ? existing.id : 'null'})">${existing ? 'Save' : 'Create role'}</button></div>`);
  } catch (e) { toast(e.message); }
}
async function submitRole(id) {
  const perms = [...document.querySelectorAll('#rbacDialog input[data-perm-key]:checked')].map(el => el.dataset.permKey);
  const body = { permissions: perms };
  if (!id) body.name = ($('rd_name') && $('rd_name').value.trim()) || '';
  try {
    await postJSON(id ? '/api/aurora/auth/admin/roles/' + id : '/api/aurora/auth/admin/roles', body);
    closeRbacDialog();
    loadRoles();
    if (havePerm('users.manage')) loadUsers();
  } catch (e) { showRbacErr(e.message); }
}

// ── Activity log ──────────────────────────────────────────────────────────
let auditCategory = '';
function setAuditFilter(btn) {
  document.querySelectorAll('#auditFilterBar .chip').forEach(b => b.classList.toggle('on', b === btn));
  auditCategory = btn.dataset.cat || '';
  loadAudit();
}
const AUDIT_LABELS = {
  'auth.login': 'Signed in', 'auth.login.fail': 'Failed sign-in', 'auth.logout': 'Signed out',
  'auth.setup': 'Claimed admin', 'auth.pin.change': 'Changed PIN',
  'photo.favorite': 'Favourited', 'photo.unfavorite': 'Unfavourited',
  'photo.tag.add': 'Added a tag', 'photo.tag.remove': 'Removed a tag',
  'photo.hide': 'Hid a photo', 'photo.unhide': 'Unhid a photo',
  'photo.remove': 'Removed from library', 'photo.restore': 'Restored to library',
  'photo.download': 'Downloaded an original',
  'album.create': 'Created an album', 'album.delete': 'Deleted an album',
  'import.start': 'Started an import', 'import.reindex': 'Re-indexed metadata',
  'user.create': 'Created a user', 'user.delete': 'Deleted a user', 'user.role': 'Changed a role',
  'user.disabled': 'Changed sign-in access', 'user.pin.reset': 'Reset a PIN', 'user.profile': 'Edited a profile',
  'role.create': 'Created a role', 'role.update': 'Updated a role', 'role.delete': 'Deleted a role',
};
async function loadAudit() {
  const list = $('auditList');
  const qs = '?limit=400' + (auditCategory && auditCategory !== 'admin' ? '&category=' + encodeURIComponent(auditCategory) : '');
  try {
    let { entries } = await getJSON('/api/aurora/auth/admin/audit' + qs);
    if (auditCategory === 'admin') entries = entries.filter(e => /^(user|role)\./.test(e.action));
    list.innerHTML = entries.map(e => `
      <div class="row static audit-row">
        <span class="row-label"><b>${escapeHtml(e.username || 'Someone')}</b> · ${escapeHtml(AUDIT_LABELS[e.action] || e.action)}
          ${e.target || e.details ? `<small>${escapeHtml([e.target, e.details].filter(Boolean).join(' · '))}</small>` : ''}</span>
        <span class="when" title="${escapeHtml(new Date(e.ts).toLocaleString('en-GB'))}">${fmtRelative(e.ts)}</span>
      </div>`).join('') || '<div class="row muted">Nothing in this category yet.</div>';
  } catch (e) { list.innerHTML = `<div class="row muted">Couldn’t load the log: ${escapeHtml(e.message)}</div>`; }
}
