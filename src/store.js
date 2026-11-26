'use strict';
// Tiny JSON file store with atomic writes. Files live in the app's userData folder
// (on Windows: %APPDATA%\SiteWatch).
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.pending = new Map();
    this.timers = new Map();
  }
  file(name) { return path.join(this.dir, `${name}.json`); }

  load(name, fallback) {
    for (const f of [this.file(name), this.file(name) + '.bak']) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    }
    return fallback;
  }

  writeNow(name, data) {
    const f = this.file(name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch {}
    fs.renameSync(tmp, f);
  }

  /** debounce=true batches frequent writes (history) into one per 2s. */
  save(name, data, debounce = false) {
    if (!debounce) {
      this.cancel(name);
      return this.writeNow(name, data);
    }
    this.pending.set(name, data);
    if (!this.timers.has(name)) {
      this.timers.set(name, setTimeout(() => this.flushOne(name), 2000));
    }
  }
  cancel(name) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    this.pending.delete(name);
  }
  flushOne(name) {
    const data = this.pending.get(name);
    this.timers.delete(name);
    this.pending.delete(name);
    if (data !== undefined) { try { this.writeNow(name, data); } catch (e) { console.error('save failed', name, e); } }
  }
  flush() { for (const name of [...this.pending.keys()]) { clearTimeout(this.timers.get(name)); this.flushOne(name); } }
}

module.exports = { Store };
