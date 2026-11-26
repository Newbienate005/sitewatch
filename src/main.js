'use strict';
const path = require('path');
const zlib = require('zlib');
const {
  app, BrowserWindow, ipcMain, Notification, Tray, Menu, globalShortcut,
  nativeImage, nativeTheme, powerMonitor, shell,
} = require('electron');
const { Store } = require('./store');
const { Monitor } = require('./monitor');

const APP_ID = 'com.sitewatch.app';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // needed for Windows toast notifications

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let tray = null;
let monitor = null;
let store = null;
let quitting = false;
let shortcutError = null;

// ---------- tiny PNG encoder for coloured status-dot icons (no image assets needed) ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function dotPng(size, [r, g, b]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = (size - 1) / 2, rad = size * 0.42;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const ring = d > rad - size * 0.08; // subtle darker rim for contrast on any taskbar
      const a = Math.max(0, Math.min(1, rad + 0.5 - d));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = ring ? r * 0.7 : r; raw[o + 1] = ring ? g * 0.7 : g; raw[o + 2] = ring ? b * 0.7 : b; raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const COLORS = { green: [34, 197, 94], amber: [245, 158, 11], red: [239, 68, 68], unknown: [148, 163, 184] };
const iconCache = {};
function statusIcon(level) {
  if (!iconCache[level]) {
    const img = nativeImage.createEmpty();
    for (const [size, scale] of [[16, 1], [32, 2], [48, 3]]) {
      img.addRepresentation({ scaleFactor: scale, width: 16, height: 16, buffer: dotPng(size, COLORS[level] || COLORS.unknown) });
    }
    iconCache[level] = img;
  }
  return iconCache[level];
}

// ---------- window ----------
function createWindow() {
  const bounds = store.load('window', { width: 560, height: 420 });
  win = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 220,
    show: false,
    title: 'SiteWatch',
    icon: statusIcon('green'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f7f8fa',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });

  const saveBounds = () => { if (!win.isMinimized() && !win.isMaximized()) store.save('window', win.getBounds(), true); };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', (e) => {
    if (!quitting && monitor.settings.closeToTray) { e.preventDefault(); win.hide(); }
  });
  // Links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow(siteId) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (siteId) win.webContents.send('open-site', siteId);
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

// ---------- tray ----------
function updateTray(snap) {
  if (!tray) return;
  tray.setImage(statusIcon(snap.overall));
  const down = snap.sites.filter((s) => s.level === 'red').length;
  const warn = snap.sites.filter((s) => s.level === 'amber').length;
  tray.setToolTip(`SiteWatch — ${snap.sites.length} site(s)` + (down ? ` · ${down} down` : '') + (warn ? ` · ${warn} warning` : '') + (!down && !warn && snap.sites.length ? ' · all OK' : ''));
  if (win) win.setIcon(statusIcon(snap.overall));
}

function createTray() {
  tray = new Tray(statusIcon('unknown'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: () => showWindow() },
    { label: 'Check all now', click: () => monitor.checkAll() },
    { type: 'separator' },
    { label: 'Quit SiteWatch', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => toggleWindow());
}

// ---------- shortcut / login item / theme ----------
function applyShortcut(accel) {
  globalShortcut.unregisterAll();
  shortcutError = null;
  if (!accel) return;
  try {
    if (!globalShortcut.register(accel, () => toggleWindow())) {
      shortcutError = `${accel} is already in use by another app`;
    }
  } catch (e) {
    shortcutError = `Invalid shortcut: ${accel}`;
  }
}

function applySettings(s) {
  nativeTheme.themeSource = s.theme || 'system';
  if (process.platform === 'win32' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!s.startWithWindows, args: ['--hidden'] });
  }
}

// ---------- notifications ----------
function notify({ siteId, title, body }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: statusIcon(title.includes('UP') ? 'green' : title.includes('🟠') ? 'amber' : 'red'), timeoutType: 'default' });
  n.on('click', () => showWindow(siteId));
  n.show();
}

// ---------- boot ----------
app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  monitor = new Monitor({ store, notify });
  applySettings(monitor.settings);
  createWindow();
  createTray();
  applyShortcut(monitor.settings.shortcut);

  monitor.on('change', (snap) => {
    updateTray(snap);
    if (win && !win.isDestroyed()) win.webContents.send('state', { ...snap, shortcutError });
  });

  const wrap = (fn) => async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
  };
  ipcMain.handle('snapshot', wrap(() => ({ ...monitor.snapshot(), shortcutError })));
  ipcMain.handle('add-site', wrap((s) => monitor.addSite(s)));
  ipcMain.handle('update-site', wrap((id, patch) => monitor.updateSite(id, patch)));
  ipcMain.handle('remove-site', wrap((id) => monitor.removeSite(id)));
  ipcMain.handle('reorder', wrap((ids) => monitor.reorder(ids)));
  ipcMain.handle('check-all', wrap(() => { monitor.checkAll(); return true; }));
  ipcMain.handle('check-one', wrap((id) => monitor.checkOne(id)));
  ipcMain.handle('detail', wrap((id) => monitor.detail(id)));
  ipcMain.handle('open-url', wrap((url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); }));
  ipcMain.handle('update-settings', wrap((patch) => {
    const s = monitor.updateSettings(patch);
    applySettings(s);
    if (patch.shortcut !== undefined) applyShortcut(s.shortcut);
    monitor.emitChange();
    return { settings: s, shortcutError };
  }));

  monitor.start();
  setTimeout(() => monitor.checkAll(), 1500);

  // After sleep, the schedule is stale: check as soon as the network is likely back.
  powerMonitor.on('resume', () => setTimeout(() => { monitor.start(); monitor.checkAll(); }, 10000));
});

app.on('second-instance', () => showWindow());
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (store) store.flush(); });
app.on('window-all-closed', () => { /* keep running in tray */ });
