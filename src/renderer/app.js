'use strict';
/* global api */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------- icons (Lucide paths, ISC licence) ----------
const ICONS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
for (const i of document.querySelectorAll('i[data-icon]')) i.outerHTML = icon(i.dataset.icon);

let snap = null;
let view = 'list';
let detailId = null;
let editingId = null;
let showAllChecks = false;
const SEARCH_MIN_SITES = 10;
const DRAFT_KEY = 'sitewatch.draft.add';

// ---------- storage helpers (per-viewer convenience only) ----------
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- formatting ----------
function host(url) { try { const u = new URL(url); return u.host + (u.pathname !== '/' ? u.pathname : ''); } catch { return url; } }
function ago(ts) {
  if (!ts) return 'not checked yet';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function dur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function clock(ts) {
  const d = new Date(ts);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString() ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}
function msText(ms) { return ms == null ? '–' : ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`; }
function sslDays(last) { return last && last.ssl && typeof last.ssl.daysLeft === 'number' ? last.ssl.daysLeft : null; }
function sslCls(days, s) { return days == null ? '' : days <= s.sslCritDays ? 'ssl-crit' : days <= s.sslWarnDays ? 'ssl-warn' : ''; }
function sslText(site, last) {
  if (site.url.startsWith('http:')) return 'n/a';
  if (!last || !last.ssl) return '–';
  if (last.ssl.error) return '?';
  return last.ssl.daysLeft < 0 ? 'exp.' : `${last.ssl.daysLeft}d`;
}
const dotClass = (level) => (['green', 'amber', 'red'].includes(level) ? level : '');
const LEVEL_WORD = { red: 'Down', amber: 'Warning', green: 'Up', unknown: 'Unknown', pending: 'Not checked yet' };

// ---------- views ----------
function show(next) {
  view = next;
  $('#view-list').hidden = next !== 'list';
  $('#view-detail').hidden = next !== 'detail';
  $('#view-settings').hidden = next !== 'settings';
  hideTip();
}

// ---------- list ----------
function renderList() {
  if (!snap) return;
  document.documentElement.dataset.theme = snap.settings.theme || 'system';
  const { sites, settings } = snap;
  $('#overall-dot').className = `dot ${dotClass(snap.overall)}`;
  const count = (lv) => sites.filter((s) => s.level === lv).length;
  const parts = [count('green') && `${count('green')} up`, count('red') && `${count('red')} down`, count('amber') && `${count('amber')} warning`].filter(Boolean);
  $('#summary').textContent = sites.length ? (parts.join(' · ') || 'Checking…') : '';

  // Search only earns its space once the list is long.
  const toolbar = $('#toolbar');
  const searchOn = sites.length > SEARCH_MIN_SITES;
  toolbar.hidden = !searchOn;
  const q = searchOn ? $('#search').value.trim().toLowerCase() : '';

  const shown = sites
    .filter((s) => !q || (s.nickname || '').toLowerCase().includes(q) || s.url.toLowerCase().includes(q)); // keep the user's own order

  const empty = $('#empty');
  empty.replaceChildren();
  $('#thead').hidden = shown.length === 0;
  if (!sites.length) {
    empty.append(el('h2', '', 'No sites yet'),
      el('p', '', `Add a website and SiteWatch checks its uptime, response time and SSL certificate every ${settings.intervalMinutes} minutes.`));
    const b = el('button', 'btn primary'); b.type = 'button'; b.innerHTML = icon('plus'); b.append('Add site'); b.onclick = () => openSheet();
    empty.append(b);
  } else if (!shown.length) {
    empty.append(el('h2', '', `No sites match “${$('#search').value.trim()}”`), el('p', '', 'Check the spelling, or search by nickname or address.'));
    const b = el('button', 'btn'); b.type = 'button'; b.textContent = 'Clear search';
    b.onclick = () => { $('#search').value = ''; renderList(); $('#search').focus(); };
    empty.append(b);
  }
  empty.hidden = shown.length > 0;

  const rows = $('#rows');
  const focusedId = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.id;
  rows.replaceChildren(...shown.map((s) => {
    const wrap = el('div'); wrap.setAttribute('role', 'listitem');
    const r = el('button', 'row'); r.type = 'button'; r.dataset.id = s.id;
    const last = s.last;
    const name = s.nickname || host(s.url);
    r.setAttribute('aria-label', `${name}, ${LEVEL_WORD[s.level]}${s.checking ? ', checking now' : ''}. Open details`);
    r.appendChild(el('span', `dot ${dotClass(s.level)}${s.checking ? ' checking' : ''}`));

    const info = el('span', 'r-info');
    info.appendChild(el('span', 'r-name', name)); info.lastChild.style.display = 'block';
    let sub;
    const checkedText = s.checking ? 'Checking…' : ago(last && last.ts);
    if (last && !last.up && last.error) {
      sub = el('span', last.offline ? 'r-sub warn' : 'r-sub bad', last.error + (s.downSince ? ` · ${dur(Date.now() - s.downSince)}` : ''));
    } else if (last && last.warn) {
      sub = el('span', 'r-sub warn', `${last.warn} · ${host(s.url)}`);
    } else {
      sub = el('span', 'r-sub', s.nickname ? host(s.url) : s.url);
    }
    sub.append(el('span', 'sub-checked', ` · ${checkedText}`));
    sub.style.display = 'block';
    info.appendChild(sub);
    r.appendChild(info);

    r.appendChild(el('span', 'col-checked num', checkedText));
    const ms = el('span', 'r-num num', last && last.up ? msText(last.ms) : '–');
    if (last && last.up && last.ms > 3000) ms.classList.add('slow');
    r.appendChild(ms);
    const days = sslDays(last);
    r.appendChild(el('span', `r-num num ${sslCls(days, settings)}`, sslText(s, last)));
    const chev = el('span', 'r-chev'); chev.innerHTML = icon('chevron'); r.appendChild(chev);

    r.onclick = () => openDetail(s.id);
    r.onkeydown = (e) => {
      const all = [...rows.querySelectorAll('.row')];
      const i = all.indexOf(r);
      if (e.key === 'ArrowDown') { e.preventDefault(); (all[i + 1] || r).focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (all[i - 1] || r).focus(); }
      if (e.key === 'Delete') { e.preventDefault(); deleteSite(s, r); }
    };
    wrap.appendChild(r);
    return wrap;
  }));
  if (focusedId) { const f = rows.querySelector(`.row[data-id="${focusedId}"]`); if (f) f.focus(); }

  const checking = sites.filter((s) => s.checking).length;
  $('#btn-check-all').setAttribute('aria-busy', checking ? 'true' : 'false');

  const foot = $('#foot');
  const shortcut = settings.shortcut ? settings.shortcut.replace(/Control/g, 'Ctrl') : '';
  if (checking) foot.textContent = `Checking ${checking} of ${sites.length} site${sites.length === 1 ? '' : 's'}…`;
  else {
    const next = snap.nextRunAt ? Math.max(0, Math.round((snap.nextRunAt - Date.now()) / 60000)) : null;
    foot.textContent = `Every ${settings.intervalMinutes} min` + (next != null ? ` · next check in ${next < 1 ? 'under a minute' : next + ' min'}` : '') + (shortcut ? ` · ${shortcut} opens SiteWatch` : '');
  }

  const msgs = [];
  if (snap.shortcutError) msgs.push(`The shortcut isn't working: ${snap.shortcutError}. Pick another one in Settings.`);
  if (sites.length && sites.every((s) => s.last && s.last.offline)) msgs.push('This computer looks offline, so checks are paused and no alerts are sent. They resume when it reconnects.');
  $('#banner').hidden = !msgs.length;
  $('#banner').textContent = msgs.join(' ');
}

// ---------- detail ----------
async function openDetail(id) {
  detailId = id;
  showAllChecks = false;
  show('detail');
  await renderDetail();
  $('#btn-back').focus();
}
function backToList(focusId) {
  const id = focusId || detailId;
  detailId = null;
  show('list');
  renderList();
  const r = id && document.querySelector(`.row[data-id="${id}"]`);
  (r || document.querySelector('.row') || $('#btn-add')).focus();
}

async function renderDetail() {
  if (!detailId) return;
  const res = await api.detail(detailId);
  if (!res.ok || !res.data) { backToList(); return; }
  const d = res.data;
  const s = d.site;
  const settings = snap.settings;
  const live = snap.sites.find((x) => x.id === s.id);
  const last = s.last;
  const checking = !!(live && live.checking);

  $('#d-dot').className = `dot ${dotClass(s.level)}${checking ? ' checking' : ''}`;
  $('#d-name').textContent = s.nickname || host(s.url);
  $('#d-url').textContent = s.url;
  $('#d-url').onclick = (e) => { e.preventDefault(); api.openUrl(s.url); };
  $('#d-check').setAttribute('aria-busy', checking ? 'true' : 'false');

  const st = $('#d-status');
  st.replaceChildren();
  if (checking) st.append(el('div', '', 'Checking now…'));
  if (!last) st.append(el('div', '', 'Not checked yet.'));
  else {
    const word = last.offline ? 'Unknown (this computer is offline)' : last.up ? (s.level === 'green' ? 'Up' : 'Up, with warnings') : 'Down';
    const line = el('div');
    line.append(el('span', last.offline ? 'warn' : last.up ? (s.level === 'green' ? 'good' : 'warn') : 'bad', word),
      `${last.status && !last.error ? ' · HTTP ' + last.status : ''} · checked ${ago(last.ts)}`);
    st.append(line);
    if (last.error) st.append(el('div', 'bad', last.error));
    if (last.warn) st.append(el('div', 'warn', last.warn));
    if (live && live.downSince) st.append(el('div', 'bad', `Down for ${dur(Date.now() - live.downSince)}, since ${clock(live.downSince)}`));
    if (last.final) st.append(el('div', '', `Redirects to ${last.final}`));
    if (last.ssl && last.ssl.authError) st.append(el('div', 'bad', `SSL problem: ${last.ssl.authError}`));
    if (s.keyword) st.append(el('div', '', `Keyword “${s.keyword}”: ${last.keywordOk == null ? 'not checked' : last.keywordOk ? 'found' : 'missing'}`));
  }

  const days = sslDays(last);
  const tile = (k, v, sub, cls) => { const t = el('div', 'tile'); t.append(el('div', 'k', k), el('div', `v ${cls || ''}`, v)); if (sub) t.append(el('div', 'sub', sub)); return t; };
  $('#d-tiles').replaceChildren(
    tile('Uptime, 24h', d.uptime == null ? '–' : `${d.uptime >= 99.95 ? '100' : d.uptime.toFixed(1)}%`, `${d.checks.length} checks`),
    tile('Response', last && last.up ? msText(last.ms) : '–', d.avgMs != null ? `Average ${msText(d.avgMs)}` : ''),
    tile('SSL expires', days == null ? (s.url.startsWith('http:') ? 'No SSL' : '–') : days < 0 ? 'Expired' : `${days} days`,
      last && last.ssl && last.ssl.validTo ? new Date(last.ssl.validTo).toLocaleDateString() : '', sslCls(days, settings)),
  );

  // 24h timeline: 96 slots of 15 minutes, each showing the worst result inside it.
  const SLOTS = 96, span = d.rangeMs, start = d.now - span;
  const slots = Array(SLOTS).fill(null);
  const rank = { grey: 0, green: 1, amber: 2, red: 3 };
  for (const c of d.checks) {
    const i = Math.min(SLOTS - 1, Math.floor(((c.t - start) / span) * SLOTS));
    if (i < 0) continue;
    const lv = c.o ? 'grey' : !c.up ? 'red' : (c.w || (c.d != null && c.d <= settings.sslWarnDays)) ? 'amber' : 'green';
    if (!slots[i] || rank[lv] > rank[slots[i].lv]) slots[i] = { lv, c };
  }
  const tl = $('#d-timeline');
  const failed = d.checks.filter((c) => !c.up && !c.o).length;
  tl.setAttribute('role', 'img');
  tl.setAttribute('aria-label', `${d.checks.length} checks in the last 24 hours, ${failed} failed`);
  tl.replaceChildren(...slots.map((x, i) => {
    const b = el('span', x ? x.lv : '');
    const t0 = start + (i * span) / SLOTS;
    b.title = x ? `${clock(t0)} · ${x.c.up ? `up · ${msText(x.c.ms)}` : x.c.e || 'down'}` : `${clock(t0)} · no data`;
    return b;
  }));
  $('#d-range').textContent = d.checks.length ? `· ${failed} failed` : '· no data yet';

  const svg = $('#d-spark');
  const pts = d.checks.filter((c) => c.up && c.ms != null);
  svg.replaceChildren();
  if (pts.length >= 2) {
    const W = 1000, H = 64, max = Math.max(...pts.map((p) => p.ms)) * 1.15;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const xy = pts.map((p) => [((p.t - start) / span) * W, H - 4 - (p.ms / max) * (H - 24)]);
    const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    const ns = 'http://www.w3.org/2000/svg';
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', `${line}L${xy[xy.length - 1][0]},${H}L${xy[0][0]},${H}Z`);
    area.setAttribute('fill', 'var(--accent)'); area.setAttribute('opacity', '.12');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', line); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'var(--accent)');
    path.setAttribute('stroke-width', '1.5'); path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(area, path);
    $('#d-spark-label').textContent = `Response time · peak ${msText(d.maxMs)}`;
  } else {
    $('#d-spark-label').textContent = 'The response time chart appears after a few checks';
  }

  const inc = $('#d-incidents');
  if (!d.incidents.length) inc.replaceChildren(el('div', 'none', 'No downtime in the last 30 days.'));
  else inc.replaceChildren(...d.incidents.map((i) => {
    const it = el('div', 'item');
    it.append(el('span', 'when', clock(i.start)), el('span', 'what', i.reason || 'Down'));
    it.append(i.end ? el('span', 'meta', dur(i.end - i.start)) : el('span', 'meta ongoing', `Ongoing · ${dur(Date.now() - i.start)}`));
    it.title = i.reason || '';
    return it;
  }));

  const list = d.checks.slice().reverse();
  const shown = showAllChecks ? list : list.slice(0, 15);
  const box = $('#d-checks');
  if (!list.length) box.replaceChildren(el('div', 'none', 'No checks yet.'));
  else {
    box.replaceChildren(...shown.map((c) => {
      const it = el('div', 'item');
      it.append(el('span', 'dot ' + (c.o ? '' : !c.up ? 'red' : c.w ? 'amber' : 'green')), el('span', 'when', clock(c.t)),
        el('span', 'what', c.o ? 'Offline, not counted' : c.up ? (c.w || `HTTP ${c.s}`) : (c.e || 'Down')),
        el('span', 'meta', c.up ? msText(c.ms) : ''));
      it.title = c.e || c.w || '';
      return it;
    }));
    if (list.length > shown.length) {
      const more = el('button', 'more', `Show all ${list.length} checks`); more.type = 'button';
      more.onclick = () => { showAllChecks = true; renderDetail(); };
      box.append(more);
    }
  }
}

// ---------- destructive confirm ----------
function confirmDestructive({ title, body, action }) {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-ok').textContent = action;
  return new Promise((resolve) => {
    const done = (v) => { cleanup(); if (dlg.open) dlg.close(); resolve(v); };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === dlg) done(false); };
    const onEsc = (e) => { e.preventDefault(); done(false); };
    const cleanup = () => {
      $('#confirm-ok').removeEventListener('click', onOk);
      $('#confirm-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('click', onBackdrop);
      dlg.removeEventListener('cancel', onEsc);
    };
    $('#confirm-ok').addEventListener('click', onOk);
    $('#confirm-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('click', onBackdrop);
    dlg.addEventListener('cancel', onEsc);
    dlg.showModal();
    $('#confirm-cancel').focus();
  });
}
async function deleteSite(site) {
  const name = site.nickname || host(site.url);
  const ok = await confirmDestructive({
    title: `Delete site “${name}”?`,
    body: 'Monitoring stops, and its check history and incident log are deleted. This can’t be undone.',
    action: 'Delete site',
  });
  if (!ok) return;
  await api.removeSite(site.id);
  if (view === 'detail') backToList(null);
  else { const r = document.querySelector('.row'); (r || $('#btn-add')).focus(); }
}

// ---------- add / edit slide-over ----------
function validateUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return 'Enter a website address, like example.com.';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return 'Enter a full domain, like example.com or shop.example.co.ke.'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'Use an address that starts with http:// or https://.';
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') return 'Enter a full domain, like example.com or shop.example.co.ke.';
  return '';
}
function setFieldError(input, msg) {
  const err = document.getElementById(input.id + '-err');
  if (err) err.textContent = msg || '';
  if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}
// Blur-first validation: nothing turns red while typing; errors clear on the first edit.
function wireValidation(input, validate) {
  input.addEventListener('blur', () => { if (input.dataset.touched || input.value) { input.dataset.touched = '1'; setFieldError(input, validate(input.value)); } });
  input.addEventListener('input', () => setFieldError(input, ''));
}

const sheet = $('#sheet');
const fSite = $('#form-site');
wireValidation($('#f-url'), validateUrl);

function openSheet(site) {
  editingId = site ? site.id : null;
  fSite.reset();
  for (const i of fSite.querySelectorAll('input')) { delete i.dataset.touched; setFieldError(i, ''); }
  $('#sheet-title').textContent = site ? 'Edit site' : 'Add site';
  $('#sheet-save').textContent = site ? 'Save site' : 'Add site';
  $('#draft-note').hidden = true;
  if (site) {
    fSite.url.value = site.url; fSite.nickname.value = site.nickname || ''; fSite.keyword.value = site.keyword || '';
  } else {
    const draft = store.get(DRAFT_KEY);
    if (draft && (draft.url || draft.nickname || draft.keyword)) {
      fSite.url.value = draft.url || ''; fSite.nickname.value = draft.nickname || ''; fSite.keyword.value = draft.keyword || '';
      $('#draft-note').hidden = false;
    }
  }
  sheet.classList.remove('closing');
  sheet.showModal();
  fSite.url.focus();
}
function closeSheet() {
  if (!sheet.open || sheet.classList.contains('closing')) return;
  sheet.classList.add('closing');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => { sheet.classList.remove('closing'); sheet.close(); }, reduce ? 0 : 150);
}
sheet.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); }); // Esc is never blocked by the animation
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
$('#sheet-close').onclick = closeSheet;
$('#sheet-cancel').onclick = closeSheet;
fSite.addEventListener('input', () => {
  if (editingId) return;
  store.set(DRAFT_KEY, { url: fSite.url.value, nickname: fSite.nickname.value, keyword: fSite.keyword.value });
});
$('#draft-discard').onclick = () => { store.del(DRAFT_KEY); fSite.reset(); setFieldError(fSite.url, ''); $('#draft-note').hidden = true; fSite.url.focus(); };

fSite.addEventListener('submit', async (e) => {
  e.preventDefault();
  const urlErr = validateUrl(fSite.url.value);
  fSite.url.dataset.touched = '1';
  setFieldError(fSite.url, urlErr);
  if (urlErr) { fSite.url.focus(); return; }
  const data = { url: fSite.url.value, nickname: fSite.nickname.value, keyword: fSite.keyword.value };
  const btn = $('#sheet-save');
  btn.setAttribute('aria-busy', 'true');
  const res = editingId ? await api.updateSite(editingId, data) : await api.addSite(data);
  btn.setAttribute('aria-busy', 'false');
  if (!res.ok) { setFieldError(fSite.url, res.error); fSite.url.focus(); return; }
  if (!editingId) store.del(DRAFT_KEY);
  closeSheet();
  if (view === 'detail') renderDetail();
});

// ---------- settings ----------
const fChecks = $('#form-checks');
const RULES = {
  intervalMinutes: [1, 1440, 'Enter a number of minutes from 1 to 1440.'],
  alertRepeatMinutes: [5, 1440, 'Enter a number of minutes from 5 to 1440.'],
  sslWarnDays: [1, 365, 'Enter a number of days from 1 to 365.'],
  sslCritDays: [0, 364, 'Enter a number of days from 0 to 364.'],
};
function validateNumber(input) {
  const [min, max, msg] = RULES[input.name];
  const v = input.value.trim();
  if (v === '' || !/^\d+$/.test(v) || +v < min || +v > max) return msg;
  if (input.name === 'sslCritDays' && +v >= +fChecks.sslWarnDays.value) return 'Make this lower than the SSL warning, so the warning comes first.';
  return '';
}
for (const input of fChecks.querySelectorAll('input')) wireValidation(input, () => validateNumber(input));

function openSettings() {
  const s = snap.settings;
  for (const name of Object.keys(RULES)) { const i = fChecks.elements[name]; i.value = s[name]; delete i.dataset.touched; setFieldError(i, ''); }
  for (const i of document.querySelectorAll('[data-setting]')) { if (i.type === 'checkbox') i.checked = !!s[i.dataset.setting]; else i.value = s[i.dataset.setting]; }
  $('#f-shortcut').value = (s.shortcut || '').replace(/Control/g, 'Ctrl');
  setFieldError($('#f-shortcut'), '');
  $('#checks-saved').textContent = '';
  show('settings');
  $('#s-back').focus();
}
fChecks.addEventListener('submit', async (e) => {
  e.preventDefault();
  let first = null;
  for (const name of Object.keys(RULES)) {
    const i = fChecks.elements[name]; i.dataset.touched = '1';
    const err = validateNumber(i); setFieldError(i, err);
    if (err && !first) first = i;
  }
  if (first) { first.focus(); $('#checks-saved').textContent = ''; return; }
  const patch = {}; for (const name of Object.keys(RULES)) patch[name] = Number(fChecks.elements[name].value);
  const res = await api.updateSettings(patch);
  $('#checks-saved').textContent = res.ok ? 'Saved' : res.error;
});
fChecks.addEventListener('input', () => { $('#checks-saved').textContent = ''; });
// Switches and the theme picker save themselves.
for (const i of document.querySelectorAll('[data-setting]')) {
  i.addEventListener('change', () => api.updateSettings({ [i.dataset.setting]: i.type === 'checkbox' ? i.checked : i.value }));
}
const fShortcut = $('#f-shortcut');
fShortcut.addEventListener('keydown', async (e) => {
  if (e.key === 'Tab' || e.key === 'Escape') return;
  e.preventDefault();
  let accel;
  if (e.key === 'Backspace' || e.key === 'Delete') accel = '';
  else {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!mods.length || (mods.length === 1 && mods[0] === 'Shift')) { setFieldError(fShortcut, 'Hold Ctrl or Alt while you press the key, so the shortcut doesn’t fire while you type.'); return; }
    const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : /^F\d+$/.test(e.key) ? e.key : e.key.length === 1 ? e.key.toUpperCase() : null;
    if (!key) return;
    accel = [...mods, key].join('+');
  }
  const res = await api.updateSettings({ shortcut: accel });
  const err = !res.ok ? res.error : res.data.shortcutError;
  if (err) { setFieldError(fShortcut, `${err}. Try a different combination.`); return; }
  setFieldError(fShortcut, '');
  fShortcut.value = accel ? accel.replace(/Control/g, 'Ctrl') : '';
});
fShortcut.addEventListener('input', () => setFieldError(fShortcut, ''));

// ---------- tooltips (hover and keyboard focus) ----------
const tip = $('#tip');
let tipTimer = null;
function showTip(target) {
  const label = target.dataset.tip;
  if (!label) return;
  tip.replaceChildren(el('span', '', label));
  if (target.dataset.kbd) tip.append(el('kbd', '', target.dataset.kbd));
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, innerWidth - t.width - 8));
  let top = r.bottom + 8;
  if (top + t.height > innerHeight - 8) top = r.top - t.height - 8;
  tip.style.left = `${left}px`; tip.style.top = `${top}px`;
}
function hideTip() { clearTimeout(tipTimer); tip.hidden = true; }
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTip(t), 400);
  t.addEventListener('mouseleave', hideTip, { once: true });
});
document.addEventListener('focusin', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (t && t.matches(':focus-visible')) showTip(t); else hideTip();
});
document.addEventListener('focusout', hideTip);
document.addEventListener('mousedown', hideTip);

// ---------- wiring ----------
$('#btn-add').onclick = () => openSheet();
$('#btn-check-all').onclick = () => api.checkAll();
$('#btn-settings').onclick = openSettings;
$('#btn-back').onclick = () => backToList();
$('#s-back').onclick = () => { show('list'); renderList(); $('#btn-settings').focus(); };
$('#d-check').onclick = () => api.checkOne(detailId);
$('#d-edit').onclick = () => openSheet(snap.sites.find((s) => s.id === detailId));
$('#d-delete').onclick = () => { const s = snap.sites.find((x) => x.id === detailId); if (s) deleteSite(s); };
$('#search').addEventListener('input', renderList);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideTip();
  if (document.querySelector('dialog[open]')) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === 'Escape') {
    if (view === 'detail') backToList();
    else if (view === 'settings') $('#s-back').click();
    else if (document.activeElement === $('#search') && $('#search').value) { $('#search').value = ''; renderList(); }
    return;
  }
  if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) { e.preventDefault(); if (view === 'detail') api.checkOne(detailId); else api.checkAll(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openSheet(); return; }
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (e.key === '/' && !typing && view === 'list' && !$('#toolbar').hidden) { e.preventDefault(); $('#search').focus(); }
});

let detailTimer = null;
api.onState((s) => {
  snap = s;
  if (view === 'list') renderList();
  else document.documentElement.dataset.theme = s.settings.theme || 'system';
  if (view === 'detail') { clearTimeout(detailTimer); detailTimer = setTimeout(renderDetail, 150); }
});
api.onOpenSite((id) => { if (document.querySelector('dialog[open]')) return; openDetail(id); });

(async () => {
  const res = await api.snapshot();
  if (res.ok) { snap = res.data; renderList(); }
})();
setInterval(() => { if (snap && view === 'list') renderList(); }, 30000);
