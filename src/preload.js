const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  receive: (channel, func) => {
    ipcRenderer.on(channel, (event, ...args) => func(...args));
  },
  send: (channel, ...args) => {
    ipcRenderer.send(channel, ...args);
  },
  onExportRequest: (callback) => ipcRenderer.on('request-export-all', callback),
  sendExportData: (data) => ipcRenderer.send('export-tabs-data', data),
});