/* ════════════════════════════════════════════════════════════════════════
   Aurora 2 — search.js
   Discovery (before typing) → results (with a query or any filter).
   Each Enter commits the typed text as a token; tokens are ANDed exactly
   (strict=1). Facet chips under the count open sheets whose counts come from
   the same /assets?facets=1 response (each facet excludes its own dimension).
   Results page in as you scroll; later pages repeat the first page's
   corrected/OR interpretation so the set stays consistent.
   ════════════════════════════════════════════════════════════════════════ */

const searchScroll = $('searchResults');
const searchState = { kind: '', camera: '', country: '', fav: false, placeIds: '', placeName: '', tag: '', tagName: '', terms: [], dateFrom: 0, dateTo: 0 };
const SEARCH_PAGE = 240;
let searchMeta = { params: null, corrected: null, fuzzy: false, total: 0, facets: null };
let searchSeq = 0, searchTimer = null;

const searchGrid = new VirtualGrid({
  el: $('searchGrid'), scroller: searchScroll, name: 'search',
  padTop: () => 0, padBottom: () => (isPhone() ? 130 : 40),
  onNearEnd: () => searchLoadMore(),
});

function searchTyped() { return ($('searchInput').value || '').trim(); }
function searchHasCriteria() {
  const s = searchState;
  return !!(s.terms.length || searchTyped() || s.kind || s.camera || s.country || s.fav || s.placeIds || s.tag || s.dateFrom || s.dateTo);
}

// ── Tokens in the field ───────────────────────────────────────────────────
function renderSearchChips() {
  $('searchInput').placeholder = searchState.terms.length ? 'Add a word' : 'Search your photos';
  const el = $('searchChips');
  el.innerHTML = searchState.terms.map((t, i) =>
    `<span class="token">${escapeHtml(t)}<button type="button" data-i="${i}" aria-label="Remove ${escapeHtml(t)}">${ic('x')}</button></span>`).join('');
  $('searchClear').hidden = !searchHasCriteria();
}
$('searchChips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  e.preventDefault();
  searchState.terms.splice(+b.dataset.i, 1);
  renderSearchChips();
  runSearch();
});
function commitSearchTerm() {
  const input = $('searchInput');
  const val = input.value.trim();
  if (!val) return;
  if (!searchState.terms.some(t => t.toLowerCase() === val.toLowerCase())) searchState.terms.push(val);
  input.value = '';
  rememberSearch(searchState.terms.join(' '));
  renderSearchChips();
  runSearch();
  if (isPhone()) input.blur();
}
$('searchInput').addEventListener('input', () => {
  $('searchClear').hidden = !searchHasCriteria();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 260);
});
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); commitSearchTerm(); }
  else if (e.key === 'Backspace' && !e.target.value && searchState.terms.length) {
    e.preventDefault(); searchState.terms.pop(); renderSearchChips(); runSearch();
  }
});
function clearSearchAll() {
  Object.assign(searchState, { kind: '', camera: '', country: '', fav: false, placeIds: '', placeName: '', tag: '', tagName: '', terms: [], dateFrom: 0, dateTo: 0 });
  $('searchInput').value = '';
  renderSearchChips();
  runSearch();
}
function leaveSearch() { switchScreen(state.lastTab || 'library'); }

// ── Recent searches (this device) ─────────────────────────────────────────
function recentSearches() { try { return JSON.parse(localStorage.getItem('aurora.recentSearches') || '[]'); } catch (_) { return []; } }
function rememberSearch(q) {
  if (!q) return;
  const list = recentSearches().filter(x => x.toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  try { localStorage.setItem('aurora.recentSearches', JSON.stringify(list.slice(0, 8))); } catch (_) {}
}
function clearRecentSearches() { try { localStorage.removeItem('aurora.recentSearches'); } catch (_) {} renderDiscoverRecent(); }
function renderDiscoverRecent() {
  const list = recentSearches();
  $('discRecentSec').hidden = !list.length;
  $('discRecent').innerHTML = list.map(q => `<button type="button" class="chip" data-q="${escapeHtml(q)}">${ic('clock')}${escapeHtml(q)}</button>`).join('');
}
$('discRecent').addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]');
  if (!b) return;
  searchState.terms = [b.dataset.q];
  renderSearchChips();
  runSearch();
});

// ── Discovery ─────────────────────────────────────────────────────────────
let discoverLoadedAt = 0;
const DESCRIBE_EXAMPLES = ['girl holding a coffee', 'dog on a beach', 'birthday cake with candles', 'sunset over the sea', 'snow in the garden'];
async function loadSearchDiscovery() {
  renderDiscoverRecent();
  if (Date.now() - discoverLoadedAt < 5 * 60 * 1000) return;
  discoverLoadedAt = Date.now();
  try {
    const countries = await getJSON('/api/aurora/countries');
    const top = countries.slice(0, 12);
    $('discPlacesSec').hidden = !top.length;
    $('discPlaces').innerHTML = top.map(c => `
      <button type="button" class="disc-place" data-country="${escapeHtml(c.country)}">
        <div class="ph">${c.cover_id ? `<img loading="lazy" decoding="async" alt="" src="${thumbUrl(c.cover_id)}">` : ''}</div>
        <b>${escapeHtml(c.country)}</b><span>${c.count.toLocaleString()}</span></button>`).join('');
  } catch (_) {}
  try {
    const tags = (await getJSON('/api/aurora/tags')).filter(t => t.count > 0).slice(0, 14);
    $('discTagsSec').hidden = !tags.length;
    $('discTags').innerHTML = tags.map(t => `
      <button type="button" class="cover-card" data-tag="${t.id}" data-name="${escapeHtml(t.name)}">
        ${t.cover_id ? `<img loading="lazy" decoding="async" alt="" src="${thumbUrl(t.cover_id, 'cover')}">` : ''}
        <div class="cc-text"><b>${escapeHtml(t.name)}</b><span>${plural(t.count, 'item')}</span></div></button>`).join('');
  } catch (_) {}
  try {
    const cap = await getJSON('/api/aurora/captions/status');
    const has = (cap.captioned || 0) > 0;
    $('discDescribeSec').hidden = !has;
    if (has) $('discDescribe').innerHTML = DESCRIBE_EXAMPLES.map(q =>
      `<button type="button" class="row" data-q="${escapeHtml(q)}">${ic('sparkle')}<span class="row-label">${escapeHtml(q)}</span></button>`).join('');
  } catch (_) {}
}
$('discPlaces').addEventListener('click', (e) => {
  const b = e.target.closest('[data-country]');
  if (b) { searchState.country = b.dataset.country; renderSearchChips(); runSearch(); }
});
$('discTags').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (b) { searchState.tag = b.dataset.tag; searchState.tagName = b.dataset.name; renderSearchChips(); runSearch(); }
});
$('discDescribe').addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]');
  if (b) { searchState.terms = [b.dataset.q]; rememberSearch(b.dataset.q); renderSearchChips(); runSearch(); }
});
function searchQuick(f) {
  if (f.kind) searchState.kind = f.kind;
  if (f.fav) searchState.fav = true;
  renderSearchChips();
  runSearch();
}

// ── Run (page 1, with facets) ─────────────────────────────────────────────
function searchParams() {
  const s = searchState;
  const terms = [...s.terms];
  const typed = searchTyped();
  if (typed) terms.push(typed);
  const p = new URLSearchParams();
  const q = terms.join(' ');
  if (q) p.set('q', q);
  if (s.terms.length) p.set('strict', '1');
  if (s.kind) p.set('kind', s.kind);
  if (s.camera) p.set('camera', s.camera);
  if (s.country) p.set('country', s.country);
  if (s.fav) p.set('fav', '1');
  if (s.placeIds) p.set('place', s.placeIds);
  if (s.dateFrom) p.set('from', s.dateFrom);
  if (s.dateTo) p.set('to', s.dateTo);
  if (s.tag) p.set('tag', s.tag);
  if (state.hideRaw) p.set('hideRaw', '1');
  return { p, q };
}
async function runSearch() {
  renderSearchChips();
  const has = searchHasCriteria();
  $('searchDiscover').hidden = has;
  $('searchResultsWrap').hidden = !has;
  if (state.selectMode && state.selectGrid === searchGrid) exitSelectMode();
  if (!has) {
    searchGrid.setItems([]);
    if (window.__searchCtrl) { try { window.__searchCtrl.abort(); } catch (_) {} }
    $('searchIcon').classList.remove('busy');
    loadSearchDiscovery();
    return;
  }
  const { p, q } = searchParams();
  const params = new URLSearchParams(p);
  params.set('limit', SEARCH_PAGE); params.set('count', '1'); params.set('facets', '1');
  renderFacetRow();
  $('searchQueryLine').textContent = searchSummary(q);
  const seq = ++searchSeq;
  // Abort the previous request so the server stops working on it too (the facet
  // block uses a per-connection temp table; overlapping runs used to corrupt it).
  if (window.__searchCtrl) { try { window.__searchCtrl.abort(); } catch (_) {} }
  window.__searchCtrl = new AbortController();
  $('searchIcon').classList.add('busy');
  try {
    const res = await getJSON('/api/aurora/assets?' + params, { signal: window.__searchCtrl.signal });
    if (seq !== searchSeq) return;
    const items = res.assets || [];
    const total = res.total != null ? res.total : items.length;
    searchMeta = { params: p, corrected: res.corrected || null, fuzzy: !!res.fuzzy, total, facets: res.facets || null };
    $('searchResultsCount').textContent = total ? plural(total, 'item') : 'No results';
    const corr = $('searchCorrected');
    if (res.corrected) corr.innerHTML = `Showing results for <b>${escapeHtml(res.corrected)}</b>`;
    else if (res.fuzzy && q) corr.innerHTML = `Closest matches for <b>${escapeHtml(q)}</b>`;
    else corr.textContent = '';
    renderFacetRow();
    $('searchEmpty').hidden = items.length > 0;
    searchScroll.scrollTop = 0;
    searchGrid.hasMore = items.length < total;
    searchGrid.setItems(items);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (seq === searchSeq) { $('searchResultsCount').textContent = 'Search failed'; $('searchCorrected').textContent = 'Check the connection and try again.'; }
  } finally {
    if (seq === searchSeq) $('searchIcon').classList.remove('busy');
  }
}
async function searchLoadMore() {
  if (!searchMeta.params || !searchGrid.hasMore) return;
  const params = new URLSearchParams(searchMeta.params);
  if (searchMeta.corrected) params.set('q', searchMeta.corrected);
  if (searchMeta.fuzzy && params.get('q')) params.set('mode', 'or');
  params.set('limit', SEARCH_PAGE);
  params.set('offset', searchGrid.items.length);
  const seq = searchSeq;
  try {
    const res = await getJSON('/api/aurora/assets?' + params);
    if (seq !== searchSeq) return;
    const items = res.assets || [];
    searchGrid.hasMore = items.length > 0 && searchGrid.items.length + items.length < searchMeta.total;
    searchGrid.appendItems(items);
  } catch (_) { searchGrid.hasMore = false; }
}
function searchSummary(q) {
  const s = searchState, bits = [];
  if (q) bits.push(`“${q}”`);
  if (s.kind) bits.push(s.kind === 'photo' ? 'photos' : 'videos');
  if (s.fav) bits.push('favourites');
  if (s.placeName) bits.push('near ' + s.placeName);
  if (s.country) bits.push('in ' + s.country);
  if (s.camera) bits.push(s.camera);
  if (s.tagName) bits.push('tagged ' + s.tagName);
  if (s.dateFrom || s.dateTo) bits.push(fmtMonShort(s.dateFrom || state.timeMin) + ' – ' + fmtMonShort(s.dateTo || state.timeMax));
  return bits.join(' · ');
}

// ── Facet chips ───────────────────────────────────────────────────────────
function renderFacetRow() {
  const s = searchState, f = searchMeta.facets || {};
  const chip = (key, label, on, icon) =>
    `<button type="button" class="chip${on ? ' on' : ''}" data-facet="${key}">${icon ? ic(icon) : ''}${escapeHtml(label)}${on ? ic('x', 'down') : ic('down', 'down')}</button>`;
  let h = '';
  h += chip('kind', s.kind === 'photo' ? 'Photos' : s.kind === 'video' ? 'Videos' : 'Photos & videos', !!s.kind);
  h += `<button type="button" class="chip${s.fav ? ' on' : ''}" data-facet="fav">${ic(s.fav ? 'heart-fill' : 'heart')}Favourites</button>`;
  h += chip('date', s.dateFrom || s.dateTo ? fmtMonShort(s.dateFrom || state.timeMin) + ' – ' + fmtMonShort(s.dateTo || state.timeMax) : 'Any time', !!(s.dateFrom || s.dateTo), 'cal');
  if (s.placeIds) h += chip('place', s.placeName || 'Place', true, 'places');
  if (s.country || (f.countries && f.countries.length)) h += chip('country', s.country || 'Country', !!s.country);
  if (s.camera || (f.cameras && f.cameras.length)) h += chip('camera', s.camera || 'Camera', !!s.camera);
  if (s.tag || (f.tags && f.tags.length)) h += chip('tag', s.tagName || 'Tag', !!s.tag);
  $('facetRow').innerHTML = h;
}
$('facetRow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-facet]');
  if (!b) return;
  const s = searchState, key = b.dataset.facet;
  const clearIcon = !!e.target.closest('.i.down') && b.classList.contains('on');   // the trailing ✕
  if (key === 'fav') { s.fav = !s.fav; runSearch(); return; }
  if (key === 'place') { s.placeIds = ''; s.placeName = ''; s.dateFrom = 0; s.dateTo = 0; runSearch(); return; }
  if (clearIcon) {
    if (key === 'kind') s.kind = '';
    if (key === 'date') { s.dateFrom = 0; s.dateTo = 0; }
    if (key === 'country') s.country = '';
    if (key === 'camera') s.camera = '';
    if (key === 'tag') { s.tag = ''; s.tagName = ''; }
    runSearch();
    return;
  }
  if (key === 'kind') {
    openMenu(b, [
      { label: 'Photos & videos', checked: !s.kind, onClick: () => { s.kind = ''; runSearch(); } },
      { label: 'Photos', checked: s.kind === 'photo', icon: 'photo', onClick: () => { s.kind = 'photo'; runSearch(); } },
      { label: 'Videos', checked: s.kind === 'video', icon: 'video', onClick: () => { s.kind = 'video'; runSearch(); } },
    ]);
    return;
  }
  if (key === 'date') { openSearchRange(); return; }
  openFacetSheet(key);
});
function openFacetSheet(key) {
  const s = searchState, f = searchMeta.facets || {};
  const conf = {
    country: { title: 'Country', list: f.countries || [], val: (x) => x.country, label: (x) => x.country, any: 'Any country', cur: s.country },
    camera: { title: 'Camera', list: f.cameras || [], val: (x) => x.camera, label: (x) => x.camera, any: 'Any camera', cur: s.camera },
    tag: { title: 'Tag', list: f.tags || [], val: (x) => String(x.id), label: (x) => x.name, any: 'Any tag', cur: s.tag },
  }[key];
  if (!conf) return;
  const rows = conf.list.map(x => `<button type="button" class="row" data-v="${escapeHtml(conf.val(x))}" data-l="${escapeHtml(conf.label(x))}">
      <span class="row-label">${escapeHtml(conf.label(x))}</span><span class="val">${(x.count || 0).toLocaleString()}</span>${String(conf.cur) === String(conf.val(x)) ? ic('check', 'sm') : ''}</button>`).join('');
  const sheet = openSheet({
    title: conf.title, subtitle: 'Counts match your current search',
    html: `<div class="group"><button type="button" class="row" data-v=""><span class="row-label">${conf.any}</span>${!conf.cur ? ic('check', 'sm') : ''}</button></div>
           <div class="group-label">Top matches</div><div class="group">${rows || '<div class="row muted">Nothing to pick</div>'}</div>`,
  });
  sheet.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    if (key === 'tag') { s.tag = b.dataset.v; s.tagName = b.dataset.v ? b.dataset.l : ''; }
    else s[key] = b.dataset.v;
    sheet.close();
    runSearch();
  });
}
function openSearchRange() {
  const s = searchState, max = state.totalMonths - 1;
  const from = s.dateFrom ? clamp(monthIndexOf(s.dateFrom), 0, max) : 0;
  const to = s.dateTo ? clamp(monthIndexOf(s.dateTo), 0, max) : max;
  const apply = debounce(() => runSearch(), 300);
  openRangeSheet({
    title: 'Date', from, to,
    onChange: (f, t) => {
      const full = f <= 0 && t >= max;
      s.dateFrom = full ? 0 : addMonths(state.monthBase, f);
      s.dateTo = full ? 0 : addMonths(state.monthBase, t + 1) - 1;
      apply();
    },
  });
}

// ── Keyboard: keep the bottom dock above the on-screen keyboard (iOS) ─────
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', kb + 'px');
    document.body.classList.toggle('kb-open', kb > 80);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  const input = $('searchInput');
  // iOS scrolls the (fixed) page to reveal a focused field — undo it.
  input.addEventListener('focus', () => setTimeout(() => window.scrollTo(0, 0), 50));
  input.addEventListener('blur', () => setTimeout(() => { window.scrollTo(0, 0); sync(); }, 50));
})();

registerScreen('search', {
  enter() {
    renderSearchChips();
    if (searchHasCriteria()) { if (!searchMeta.params || !searchGrid.items.length) runSearch(); else searchGrid.relayout(); }
    else runSearch();
    if (!isPhone()) setTimeout(() => $('searchInput').focus(), 50);
  },
  leave() { $('searchInput').blur(); },
  reselect() { $('searchInput').focus(); },
});
