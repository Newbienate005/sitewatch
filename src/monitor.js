'use strict';
// Scheduling, state, incident tracking and alert de-duplication.
// Electron-free so it can be unit-tested; notifications go through `notify`.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const checker = require('./checker');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const HISTORY_KEEP_MS = 48 * HOUR;
const INCIDENT_KEEP_MS = 30 * DAY;
const CONCURRENCY = 6;

const DEFAULT_SETTINGS = {
  intervalMinutes: 10,
  sslWarnDays: 14,
  sslCritDays: 3,
  alertRepeatMinutes: 60,
  sslReminderHours: 24,
  shortcut: 'Control+Alt+M',
  theme: 'system',
  startWithWindows: false,
  closeToTray: true,
  notifyDown: true,
  notifyUp: true,
  notifySsl: true,
};

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

class Monitor extends EventEmitter {
  constructor({ store, notify, checkFn = checker.checkSite, onlineFn = checker.isOnline, now = Date.now, retryDelayMs = 5000 }) {
    super();
    this.store = store;
    this.notify = notify || (() => {});
    this.checkFn = checkFn;
    this.onlineFn = onlineFn;
    this.now = now;
    this.retryDelayMs = retryDelayMs;
    this.sites = store.load('sites', []);
    this.settings = { ...DEFAULT_SETTINGS, ...store.load('settings', {}) };
    this.history = store.load('history', {});
    this.incidents = store.load('incidents', {});
    this.state = store.load('state', {}); // per-site alert state
    this.inFlight = new Set();
    this.timer = null;
    this.onlineCache = null;
  }

  // ---------- persistence ----------
  saveSites() { this.store.save('sites', this.sites); }
  saveRuntime() {
    this.store.save('history', this.history, true);
    this.store.save('incidents', this.incidents, true);
    this.store.save('state', this.state, true);
  }

  // ---------- sites CRUD ----------
  addSite({ url, nickname, keyword }) {
    const norm = checker.normalizeUrl(url);
    if (this.sites.some((s) => s.url === norm && (s.keyword || '') === (keyword || '').trim())) throw new Error('This address is already in your list. Edit the existing entry instead.');
    const site = { id: crypto.randomUUID(), url: norm, nickname: (nickname || '').trim(), keyword: (keyword || '').trim(), added: this.now() };
    this.sites.push(site);
    this.saveSites();
    this.checkOne(site.id);
    return site;
  }

  updateSite(id, patch) {
    const site = this.sites.find((s) => s.id === id);
    if (!site) throw new Error('Site not found');
    const next = { ...site };
    if (patch.url !== undefined) {
      next.url = checker.normalizeUrl(patch.url);
      }
    if (this.sites.some((s) => s.id !== id && s.url === next.url && (s.keyword || '') === (patch.keyword !== undefined ? String(patch.keyword).trim() : next.keyword))) throw new Error('This address is already in your list. Edit the existing entry instead.');
    if (patch.nickname !== undefined) next.nickname = String(patch.nickname).trim();
    if (patch.keyword !== undefined) next.keyword = String(patch.keyword).trim();
    const changedTarget = next.url !== site.url || next.keyword !== site.keyword;
    Object.assign(site, next);
    this.saveSites();
    if (changedTarget) this.checkOne(id);
    else this.emitChange();
    return site;
  }

  removeSite(id) {
    this.sites = this.sites.filter((s) => s.id !== id);
    delete this.history[id];
    delete this.incidents[id];
    delete this.state[id];
    this.saveSites();
    this.saveRuntime();
    this.emitChange();
  }

  reorder(ids) {
    const byId = new Map(this.sites.map((s) => [s.id, s]));
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const s of this.sites) if (!next.includes(s)) next.push(s);
    this.sites = next;
    this.saveSites();
    this.emitChange();
  }

  // ---------- settings ----------
  updateSettings(patch) {
    const s = { ...this.settings, ...patch };
    s.intervalMinutes = Math.min(1440, Math.max(1, Math.round(Number(s.intervalMinutes) || 10)));
    s.sslWarnDays = Math.max(1, Math.round(Number(s.sslWarnDays) || 14));
    s.sslCritDays = Math.max(0, Math.min(s.sslWarnDays - 1, Math.round(Number(s.sslCritDays) || 3)));
    s.alertRepeatMinutes = Math.max(5, Math.round(Number(s.alertRepeatMinutes) || 60));
    const intervalChanged = s.intervalMinutes !== this.settings.intervalMinutes;
    this.settings = s;
    this.store.save('settings', s);
    if (intervalChanged && this.timer) this.start();
    this.emitChange();
    return s;
  }

  // ---------- scheduling ----------
  start() {
    this.stop();
    this.nextRunAt = this.now() + this.settings.intervalMinutes * 60000;
    this.timer = setInterval(() => {
      this.nextRunAt = this.now() + this.settings.intervalMinutes * 60000;
      this.checkAll();
    }, this.settings.intervalMinutes * 60000);
    this.emitChange();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async checkAll() {
    this.onlineCache = null;
    const queue = this.sites.map((s) => s.id);
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) await this.checkOne(queue.shift());
    });
    await Promise.all(workers);
  }

  async isOnline() {
    // Cache for one minute so a big outage doesn't probe per site.
    if (this.onlineCache && this.now() - this.onlineCache.at < 60000) return this.onlineCache.value;
    // If any other site answered recently, our connection is fine.
    const anyUp = this.sites.some((s) => {
      const st = this.state[s.id];
      return st && st.lastOkAt && this.now() - st.lastOkAt < 2 * 60000;
    });
    const value = anyUp || (await this.onlineFn());
    this.onlineCache = { at: this.now(), value };
    return value;
  }

  async checkOne(id) {
    if (this.inFlight.has(id)) return;
    const site = this.sites.find((s) => s.id === id);
    if (!site) return;
    this.inFlight.add(id);
    this.emitChange();
    try {
      const st = this.state[id] || (this.state[id] = {});
      let result = await this.checkFn(site);
      if (!result.up && !st.downSince) {
        // Confirm before declaring a new outage: one blip shouldn't page you.
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
        if (!this.sites.find((s) => s.id === id)) return;
        result = await this.checkFn(site);
      }
      if (!result.up && !(await this.isOnline())) {
        result.offline = true;
        result.error = 'This computer appears to be offline';
      }
      this.record(site, result);
    } catch (e) {
      this.record(site, { ts: this.now(), up: false, status: null, ms: null, error: e.message || String(e), ssl: null });
    } finally {
      this.inFlight.delete(id);
      this.saveRuntime();
      this.emitChange();
    }
  }

  // ---------- state machine ----------
  sslLevel(ssl) {
    if (!ssl || ssl.error || typeof ssl.daysLeft !== 'number') return 'ok';
    if (ssl.daysLeft <= this.settings.sslCritDays) return 'crit';
    if (ssl.daysLeft <= this.settings.sslWarnDays) return 'warn';
    return 'ok';
  }

  record(site, r) {
    const id = site.id;
    const now = this.now();
    const st = this.state[id] || (this.state[id] = {});
    const name = site.nickname || new URL(site.url).hostname;

    const h = this.history[id] || (this.history[id] = []);
    h.push({
      t: r.ts || now, up: r.up, s: r.status, ms: r.ms, e: r.error || undefined, w: r.warn || undefined,
      d: r.ssl && typeof r.ssl.daysLeft === 'number' ? r.ssl.daysLeft : undefined, o: r.offline || undefined,
    });
    while (h.length && now - h[0].t > HISTORY_KEEP_MS) h.shift();
    st.last = r;

    if (r.offline) return; // can't judge the site while we're offline

    const inc = this.incidents[id] || (this.incidents[id] = []);
    while (inc.length && inc[0].end && now - inc[0].end > INCIDENT_KEEP_MS) inc.shift();

    const repeatMs = this.settings.alertRepeatMinutes * 60000;
    if (!r.up) {
      if (!st.downSince) {
        st.downSince = r.ts || now;
        inc.push({ start: st.downSince, end: null, reason: r.error });
        st.lastDownAlert = now;
        if (this.settings.notifyDown) this.notify({ siteId: id, kind: 'down', title: `🔴 ${name} is DOWN`, body: r.error || 'Not responding' });
      } else {
        const open = inc[inc.length - 1];
        if (open && !open.end) open.reason = open.reason || r.error;
        if (now - (st.lastDownAlert || 0) >= repeatMs) {
          st.lastDownAlert = now;
          if (this.settings.notifyDown) this.notify({ siteId: id, kind: 'down', title: `🔴 ${name} still DOWN`, body: `${r.error || 'Not responding'} · down for ${fmtDuration(now - st.downSince)}` });
        }
      }
    } else {
      st.lastOkAt = now;
      if (st.downSince) {
        const dur = now - st.downSince;
        const open = inc[inc.length - 1];
        if (open && !open.end) open.end = now;
        st.downSince = null;
        st.lastDownAlert = null;
        if (this.settings.notifyUp) this.notify({ siteId: id, kind: 'up', title: `🟢 ${name} is back UP`, body: `Was down for ${fmtDuration(dur)} · ${r.ms} ms` });
      }
    }

    // SSL thresholds: alert on getting worse, then a reminder every sslReminderHours.
    const lvl = this.sslLevel(r.ssl);
    const rank = { ok: 0, warn: 1, crit: 2 };
    const prev = st.sslLevel || 'ok';
    if (lvl !== 'ok') {
      const worse = rank[lvl] > rank[prev];
      const due = now - (st.lastSslAlert || 0) >= this.settings.sslReminderHours * HOUR;
      if (worse || due) {
        st.lastSslAlert = now;
        const days = r.ssl.daysLeft;
        const when = days < 0 ? `expired ${-days} day(s) ago` : days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`;
        if (this.settings.notifySsl) this.notify({
          siteId: id, kind: 'ssl',
          title: `${lvl === 'crit' ? '🔴' : '🟠'} ${name}: SSL certificate ${when}`,
          body: `Valid until ${new Date(r.ssl.validTo).toLocaleDateString()}${r.ssl.issuer ? ' · ' + r.ssl.issuer : ''}`,
        });
      }
    } else {
      st.lastSslAlert = null;
    }
    st.sslLevel = lvl;
  }

  // ---------- views ----------
  level(id) {
    const st = this.state[id];
    if (!st || !st.last) return 'pending';
    const r = st.last;
    if (r.offline) return 'unknown';
    if (!r.up) return 'red';
    const ssl = this.sslLevel(r.ssl);
    if (ssl === 'crit') return 'red';
    if (ssl === 'warn' || r.warn || (r.ssl && r.ssl.error)) return 'amber';
    return 'green';
  }

  overall() {
    const lv = this.sites.map((s) => this.level(s.id));
    if (lv.includes('red')) return 'red';
    if (lv.includes('amber')) return 'amber';
    if (lv.includes('unknown')) return 'unknown';
    return lv.length ? 'green' : 'unknown';
  }

  snapshot() {
    return {
      settings: this.settings,
      nextRunAt: this.nextRunAt || null,
      overall: this.overall(),
      sites: this.sites.map((s) => {
        const st = this.state[s.id] || {};
        return { ...s, level: this.level(s.id), checking: this.inFlight.has(s.id), last: st.last || null, downSince: st.downSince || null };
      }),
    };
  }

  detail(id, rangeMs = DAY) {
    const now = this.now();
    const site = this.sites.find((s) => s.id === id);
    if (!site) return null;
    const checks = (this.history[id] || []).filter((c) => now - c.t <= rangeMs);
    const incidents = (this.incidents[id] || []).filter((i) => !i.end || now - i.end <= 30 * DAY).slice().reverse();
    const judged = checks.filter((c) => !c.o);
    const upCount = judged.filter((c) => c.up).length;
    const times = checks.filter((c) => c.up && c.ms != null).map((c) => c.ms);
    return {
      site: { ...site, level: this.level(id), last: (this.state[id] || {}).last || null },
      checks, incidents, now, rangeMs,
      uptime: judged.length ? (upCount / judged.length) * 100 : null,
      avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      maxMs: times.length ? Math.max(...times) : null,
    };
  }

  emitChange() { this.emit('change', this.snapshot()); }
}

module.exports = { Monitor, DEFAULT_SETTINGS, fmtDuration };
