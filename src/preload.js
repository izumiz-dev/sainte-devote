const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Only these IPC channels may cross the bridge. This prevents a compromised
// renderer (e.g. via XSS in the markdown preview) from invoking arbitrary
// main-process handlers.
const SEND_CHANNELS = new Set([
  'save-file',
  'save-file-to-path',
  'close-file',
  'open-external',
  'set-title-bar-theme',
  'export-tabs-data',
  'update-window-title',
  'renderer-ready',
]);

const RECEIVE_CHANNELS = new Set([
  'theme-changed',
  'monaco-settings',
  'save-file-success',
  'save-file-error',
  'request-export-all',
  'file-opened',
  'menu-action',
]);

const INVOKE_CHANNELS = new Set([
  'open-file-dialog',
  'get-recent-files',
  'open-recent-file',
]);

contextBridge.exposeInMainWorld('electron', {
  receive: (channel, func) => {
    if (!RECEIVE_CHANNELS.has(channel)) {
      console.warn(`Blocked ipcRenderer.on on disallowed channel: ${channel}`);
      return () => {};
    }
    const subscription = (event, ...args) => func(...args);
    ipcRenderer.on(channel, subscription);
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },
  send: (channel, ...args) => {
    if (!SEND_CHANNELS.has(channel)) {
      console.warn(`Blocked ipcRenderer.send on disallowed channel: ${channel}`);
      return;
    }
    ipcRenderer.send(channel, ...args);
  },
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.has(channel)) {
      console.warn(`Blocked ipcRenderer.invoke on disallowed channel: ${channel}`);
      return Promise.reject(new Error(`Disallowed channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  openDroppedFiles: (files) => {
    if (!files || typeof files[Symbol.iterator] !== 'function') {
      return Promise.resolve([]);
    }

    const paths = [];
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const filePath = webUtils.getPathForFile(file);
      if (filePath) paths.push(filePath);
    }

    if (!paths.length) {
      return Promise.resolve([]);
    }

    return ipcRenderer.invoke('open-dropped-files', paths);
  },
  onExportRequest: (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on('request-export-all', subscription);
    return () => {
      ipcRenderer.removeListener('request-export-all', subscription);
    };
  },
  sendExportData: (data) => ipcRenderer.send('export-tabs-data', data),
});