'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  snapshot: () => call('snapshot'),
  addSite: (s) => call('add-site', s),
  updateSite: (id, patch) => call('update-site', id, patch),
  removeSite: (id) => call('remove-site', id),
  reorder: (ids) => call('reorder', ids),
  checkAll: () => call('check-all'),
  checkOne: (id) => call('check-one', id),
  detail: (id) => call('detail', id),
  openUrl: (url) => call('open-url', url),
  updateSettings: (patch) => call('update-settings', patch),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onOpenSite: (fn) => ipcRenderer.on('open-site', (_e, id) => fn(id)),
});
