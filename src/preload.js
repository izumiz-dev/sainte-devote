const { contextBridge, ipcRenderer } = require('electron');

// Only these IPC channels may cross the bridge. This prevents a compromised
// renderer (e.g. via XSS in the markdown preview) from invoking arbitrary
// main-process handlers.
const SEND_CHANNELS = new Set([
  'save-file',
  'open-external',
  'set-title-bar-theme',
  'export-tabs-data',
]);

const RECEIVE_CHANNELS = new Set([
  'theme-changed',
  'monaco-settings',
  'save-file-success',
  'save-file-error',
  'request-export-all',
]);

contextBridge.exposeInMainWorld('electron', {
  receive: (channel, func) => {
    if (!RECEIVE_CHANNELS.has(channel)) {
      console.warn(`Blocked ipcRenderer.on on disallowed channel: ${channel}`);
      return;
    }
    ipcRenderer.on(channel, (event, ...args) => func(...args));
  },
  send: (channel, ...args) => {
    if (!SEND_CHANNELS.has(channel)) {
      console.warn(`Blocked ipcRenderer.send on disallowed channel: ${channel}`);
      return;
    }
    ipcRenderer.send(channel, ...args);
  },
  onExportRequest: (callback) => ipcRenderer.on('request-export-all', callback),
  sendExportData: (data) => ipcRenderer.send('export-tabs-data', data),
});
