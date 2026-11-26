'use strict';
/* global api */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let snap = null;
let detailId = null;
let editingId = null;
let showAllChecks = false;

// ---------- formatting ----------
function host(url) { try { const u = new URL(url); return u.host + (u.pathname !== '/' ? u.pathname : ''); } catch { return url; } }
function ago(ts) {
  if (!ts) return '—';
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
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function clock(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}
function msText(ms) { return ms == null ? '—' : ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms} ms`; }
function sslCls(days, s) { return days == null ? '' : days <= s.sslCritDays ? 'ssl-crit' : days <= s.sslWarnDays ? 'ssl-warn' : ''; }
function sslText(last) {
  if (!last || !last.ssl) return '—';
  if (last.ssl.error) return '?';
  return last.ssl.daysLeft < 0 ? 'exp.' : `${last.ssl.daysLeft}d`;
}

// ---------- dashboard ----------
function renderList() {
  if (!snap) return;
  document.documentElement.dataset.theme = snap.settings.theme || 'system';
  const { sites, settings } = snap;
  $('#overall-dot').className = `dot ${snap.overall === 'unknown' ? '' : snap.overall}`;
  const down = sites.filter((s) => s.level === 'red').length;
  const warn = sites.filter((s) => s.level === 'amber').length;
  const ok = sites.filter((s) => s.level === 'green').length;
  $('#summary').textContent = sites.length
    ? [ok && `${ok} up`, down && `${down} down`, warn && `${warn} warning`].filter(Boolean).join(' · ') || 'Checking…'
    : '';

  $('#empty').hidden = sites.length > 0;
  $('#table').hidden = sites.length === 0;

  const rows = $('#rows');
  const focusedId = document.activeElement && document.activeElement.dataset.id;
  rows.replaceChildren(...sites.map((s) => {
    const r = el('div', 'row');
    r.tabIndex = 0;
    r.dataset.id = s.id;
    const last = s.last;
    r.appendChild(el('span', `dot ${s.level === 'pending' || s.level === 'unknown' ? '' : s.level}${s.checking ? ' checking' : ''}`));
    const info = el('div');
    info.style.minWidth = '0';
    info.appendChild(el('div', 'name', s.nickname || host(s.url)));
    if (last && !last.up && last.error) info.appendChild(el('div', last.offline ? 'warntext' : 'err', last.error + (s.downSince ? ` · ${dur(Date.now() - s.downSince)}` : '')));
    else if (last && last.warn) info.appendChild(el('div', 'warntext', `${last.warn} · ${host(s.url)}`));
    else info.appendChild(el('div', 'url', s.nickname ? host(s.url) : (s.keyword ? `keyword: “${s.keyword}”` : s.url)));
    r.appendChild(info);
    r.appendChild(el('span', 'c-checked num muted', s.checking && !last ? '…' : ago(last && last.ts)));
    const ms = el('span', 'c-ms num', last && last.up ? msText(last.ms) : '—');
    if (last && last.ms > 3000) ms.classList.add('slow');
    r.appendChild(ms);
    const days = last && last.ssl && typeof last.ssl.daysLeft === 'number' ? last.ssl.daysLeft : null;
    const ssl = el('span', `c-ssl num ${sslCls(days, settings)}`, last ? (s.url.startsWith('http:') ? 'n/a' : sslText(last)) : '—');
    if (last && last.ssl) ssl.title = last.ssl.error ? last.ssl.error : `Expires ${new Date(last.ssl.validTo).toLocaleDateString()}`;
    r.appendChild(ssl);
    r.onclick = () => openDetail(s.id);
    r.onkeydown = (e) => {
      if (e.key === 'Enter') openDetail(s.id);
      if (e.key === 'ArrowDown') { e.preventDefault(); (r.nextElementSibling || r).focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (r.previousElementSibling || r).focus(); }
      if (e.key === 'Delete') confirmDelete(s);
    };
    return r;
  }));
  if (focusedId) { const f = rows.querySelector(`[data-id="${focusedId}"]`); if (f) f.focus(); }

  const anyChecking = sites.some((s) => s.checking);
  $('#btn-check-all').disabled = anyChecking;
  $('#btn-check-all').firstChild.textContent = '↻';
  $('#btn-check-all').classList.toggle('busy', anyChecking);

  const next = snap.nextRunAt ? Math.max(0, Math.round((snap.nextRunAt - Date.now()) / 60000)) : null;
  $('#foot').textContent = `Every ${settings.intervalMinutes} min` + (next != null ? ` · next check in ${next < 1 ? '<1' : next} min` : '') +
    (settings.shortcut ? ` · ${settings.shortcut.replace(/Control/g, 'Ctrl').replace(/\+/g, '+')} opens this window` : '');

  const banner = $('#banner');
  const msgs = [];
  if (snap.shortcutError) msgs.push(`Shortcut not active: ${snap.shortcutError}. Change it in Settings.`);
  if (sites.length && sites.every((s) => s.last && s.last.offline)) msgs.push('This computer looks offline. Results are paused and no alerts are sent until it reconnects.');
  banner.hidden = !msgs.length;
  banner.textContent = msgs.join(' ');
}

// ---------- detail ----------
async function openDetail(id) {
  detailId = id;
  showAllChecks = false;
  $('#view-list').hidden = true;
  $('#view-detail').hidden = false;
  await renderDetail();
  $('#btn-back').focus();
}
function closeDetail() {
  const id = detailId;
  detailId = null;
  $('#view-detail').hidden = true;
  $('#view-list').hidden = false;
  renderList();
  const r = document.querySelector(`.row[data-id="${id}"]`);
  if (r) r.focus();
}

async function renderDetail() {
  if (!detailId) return;
  const res = await api.detail(detailId);
  if (!res.ok || !res.data) { closeDetail(); return; }
  const d = res.data;
  const s = d.site;
  const settings = snap.settings;
  const live = snap.sites.find((x) => x.id === s.id);
  const last = s.last;

  $('#d-dot').className = `dot ${['pending', 'unknown'].includes(s.level) ? '' : s.level}${live && live.checking ? ' checking' : ''}`;
  $('#d-name').textContent = s.nickname || host(s.url);
  $('#d-url').textContent = s.url;
  $('#d-url').onclick = (e) => { e.preventDefault(); api.openUrl(s.url); };

  const st = $('#d-status');
  st.replaceChildren();
  if (!last) st.textContent = 'Not checked yet.';
  else {
    const span = el('span', last.offline ? 'warn' : last.up ? (s.level === 'green' ? 'good' : 'warn') : 'bad',
      last.offline ? 'Unknown (offline)' : last.up ? (s.level === 'green' ? 'Up' : 'Up, with warnings') : 'Down');
    st.append(span, `${last.status && !last.error ? ' · HTTP ' + last.status : ''} · checked ${ago(last.ts)}`);
    if (last.error) st.append(el('div', 'bad', last.error));
    if (last.warn) st.append(el('div', 'warn', last.warn));
    if (live && live.downSince) st.append(el('div', 'bad', `Down for ${dur(Date.now() - live.downSince)} (since ${clock(live.downSince)})`));
    if (last.final) st.append(el('div', '', `Redirects to ${last.final}`));
    if (last.ssl && last.ssl.authError) st.append(el('div', 'bad', `SSL problem: ${last.ssl.authError}`));
    if (s.keyword) st.append(el('div', '', `Keyword “${s.keyword}”: ${last.keywordOk == null ? 'not checked' : last.keywordOk ? 'found ✓' : 'missing ✗'}`));
  }

  const days = last && last.ssl && typeof last.ssl.daysLeft === 'number' ? last.ssl.daysLeft : null;
  const tile = (k, v, sub, cls) => { const t = el('div', 'tile'); t.append(el('div', 'k', k)); const vv = el('div', `v ${cls || ''}`, v); if (sub) vv.append(' ', el('small', '', sub)); t.append(vv); return t; };
  $('#d-tiles').replaceChildren(
    tile('Uptime (24h)', d.uptime == null ? '—' : `${d.uptime >= 99.95 ? '100' : d.uptime.toFixed(1)}%`, `${d.checks.length} checks`),
    tile('Response', last && last.up ? msText(last.ms) : '—', d.avgMs != null ? `avg ${msText(d.avgMs)}` : ''),
    tile('SSL expires', days == null ? (s.url.startsWith('http:') ? 'No SSL' : '—') : days < 0 ? 'Expired' : `${days} days`, last && last.ssl && last.ssl.validTo ? new Date(last.ssl.validTo).toLocaleDateString() : '', sslCls(days, settings)),
  );

  // 24h timeline in 96 x 15-minute slots; each slot shows the worst result inside it.
  const SLOTS = 96, span = d.rangeMs, start = d.now - span;
  const slots = Array(SLOTS).fill(null);
  const rank = { grey: 0, green: 1, amber: 2, red: 3 };
  for (const c of d.checks) {
    const i = Math.min(SLOTS - 1, Math.floor(((c.t - start) / span) * SLOTS));
    if (i < 0) continue;
    const lv = c.o ? 'grey' : !c.up ? 'red' : (c.w || (c.d != null && c.d <= settings.sslWarnDays)) ? 'amber' : 'green';
    const prev = slots[i];
    if (!prev || rank[lv] > rank[prev.lv]) slots[i] = { lv, c };
  }
  $('#d-timeline').replaceChildren(...slots.map((x, i) => {
    const b = el('span', x ? x.lv : '');
    const t0 = start + (i * span) / SLOTS;
    b.title = x ? `${clock(t0)} · ${x.c.up ? `up · ${msText(x.c.ms)}` : x.c.e || 'down'}` : `${clock(t0)} · no data`;
    return b;
  }));
  $('#d-range').textContent = d.checks.length ? `· ${d.checks.filter((c) => !c.up && !c.o).length} failed` : '· no data yet';

  // Response-time sparkline
  const svg = $('#d-spark');
  const pts = d.checks.filter((c) => c.up && c.ms != null);
  svg.replaceChildren();
  if (pts.length >= 2) {
    const W = 1000, H = 54, max = Math.max(...pts.map((p) => p.ms)) * 1.15;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const xy = pts.map((p) => [((p.t - start) / span) * W, H - 4 - (p.ms / max) * (H - 18)]);
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
    $('#d-spark-label').textContent = 'Response time chart appears after a few checks';
  }

  // Incidents
  const inc = $('#d-incidents');
  if (!d.incidents.length) inc.replaceChildren(el('div', 'none', 'No downtime recorded in the last 30 days.'));
  else inc.replaceChildren(...d.incidents.map((i) => {
    const it = el('div', 'item');
    it.append(el('span', 'when', clock(i.start)));
    it.append(el('span', 'what', i.reason || 'Down'));
    it.append(i.end ? el('span', 'meta', dur(i.end - i.start)) : el('span', 'meta ongoing', `ongoing · ${dur(Date.now() - i.start)}`));
    it.title = i.reason || '';
    return it;
  }));

  // Check log, newest first
  const list = d.checks.slice().reverse();
  const shown = showAllChecks ? list : list.slice(0, 15);
  const box = $('#d-checks');
  if (!list.length) box.replaceChildren(el('div', 'none', 'No checks yet.'));
  else {
    box.replaceChildren(...shown.map((c) => {
      const it = el('div', 'item');
      it.append(el('span', 'dot ' + (c.o ? '' : !c.up ? 'red' : c.w ? 'amber' : 'green')));
      it.append(el('span', 'when', clock(c.t)));
      it.append(el('span', 'what', c.o ? 'Offline, not counted' : c.up ? (c.w || `HTTP ${c.s}`) : (c.e || 'Down')));
      it.append(el('span', 'meta', c.up ? msText(c.ms) : ''));
      it.title = c.e || c.w || '';
      return it;
    }));
    if (list.length > shown.length) {
      const more = el('button', 'more', `Show all ${list.length} checks`);
      more.onclick = () => { showAllChecks = true; renderDetail(); };
      box.append(more);
    }
  }
}

// ---------- add / edit ----------
function openSiteForm(site) {
  editingId = site ? site.id : null;
  const f = $('#form-site');
  f.reset();
  $('#site-form-title').textContent = site ? 'Edit site' : 'Add site';
  $('#btn-delete').hidden = !site;
  $('#site-err').textContent = '';
  if (site) { f.url.value = site.url; f.nickname.value = site.nickname || ''; f.keyword.value = site.keyword || ''; }
  $('#dlg-site').showModal();
  f.url.focus();
}
$('#form-site').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const data = { url: f.url.value, nickname: f.nickname.value, keyword: f.keyword.value };
  const res = editingId ? await api.updateSite(editingId, data) : await api.addSite(data);
  if (!res.ok) { $('#site-err').textContent = res.error; return; }
  $('#dlg-site').close();
  if (detailId) renderDetail();
});
$('#btn-cancel-site').onclick = () => $('#dlg-site').close();
async function confirmDelete(site) {
  if (!confirm(`Stop monitoring ${site.nickname || site.url}?\nIts history will be deleted.`)) return false;
  await api.removeSite(site.id);
  return true;
}
$('#btn-delete').onclick = async () => {
  const site = snap.sites.find((s) => s.id === editingId);
  if (site && await confirmDelete(site)) { $('#dlg-site').close(); if (detailId === site.id) closeDetail(); }
};

// ---------- settings ----------
let recordedShortcut = null;
function openSettings() {
  const f = $('#form-settings');
  const s = snap.settings;
  for (const [k, v] of Object.entries(s)) {
    const input = f.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!v; else input.value = v;
  }
  recordedShortcut = s.shortcut;
  $('#settings-err').textContent = '';
  $('#shortcut-msg').textContent = 'Click the box and press a new combination. Backspace clears it.';
  $('#dlg-settings').showModal();
}
const shortcutInput = $('#shortcut-input');
shortcutInput.addEventListener('focus', () => shortcutInput.classList.add('recording'));
shortcutInput.addEventListener('blur', () => shortcutInput.classList.remove('recording'));
shortcutInput.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' || e.key === 'Escape') return;
  e.preventDefault();
  if (e.key === 'Backspace' || e.key === 'Delete') { recordedShortcut = ''; shortcutInput.value = ''; return; }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (!mods.length || (mods.length === 1 && mods[0] === 'Shift')) { $('#shortcut-msg').textContent = 'Use Ctrl or Alt plus a key so it doesn’t clash with typing.'; return; }
  let key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : /^F\d+$/.test(e.key) ? e.key : e.key.length === 1 ? e.key.toUpperCase() : null;
  if (!key) return;
  recordedShortcut = [...mods, key].join('+');
  shortcutInput.value = recordedShortcut;
  $('#shortcut-msg').textContent = 'Save to apply.';
});
$('#form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const patch = {};
  for (const input of f.elements) {
    if (!input.name || input.name === 'shortcut') continue;
    patch[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  }
  patch.shortcut = recordedShortcut;
  const res = await api.updateSettings(patch);
  if (!res.ok) { $('#settings-err').textContent = res.error; return; }
  if (res.data.shortcutError) { $('#settings-err').textContent = res.data.shortcutError; return; }
  $('#dlg-settings').close();
});
$('#btn-cancel-settings').onclick = () => $('#dlg-settings').close();

// ---------- wiring ----------
$('#btn-add').onclick = () => openSiteForm();
$('#btn-add-empty').onclick = () => openSiteForm();
$('#btn-check-all').onclick = () => api.checkAll();
$('#btn-settings').onclick = openSettings;
$('#btn-back').onclick = closeDetail;
$('#d-check').onclick = () => api.checkOne(detailId);
$('#d-edit').onclick = () => openSiteForm(snap.sites.find((s) => s.id === detailId));

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape' && detailId) closeDetail();
  if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) { e.preventDefault(); detailId ? api.checkOne(detailId) : api.checkAll(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openSiteForm(); }
});

let detailTimer = null;
api.onState((s) => {
  snap = s;
  renderList();
  if (detailId) { clearTimeout(detailTimer); detailTimer = setTimeout(renderDetail, 150); }
});
api.onOpenSite((id) => { if (document.querySelector('dialog[open]')) return; openDetail(id); });

(async () => {
  const res = await api.snapshot();
  if (res.ok) { snap = res.data; renderList(); }
})();
setInterval(() => { if (snap) { renderList(); } }, 30000);
