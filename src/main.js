const {
  app,
  BrowserWindow,
  nativeTheme,
  shell,
  ipcMain
} = require('electron');

const path = require('path');
const fs = require('fs');

let win;

const isDev = process.env.NODE_ENV === 'development';

if (isDev) {
  require('electron-reload')(__dirname, {
    electron: require('path').join(
      __dirname,
      '..',
      'node_modules',
      '.bin',
      'electron'
    ),
    forceHardReset: true,
    hardResetMethod: 'exit',
  });
}

const monacoSettings = {
  width: 400,
  height: 600,
  minWidth: 400,
  minHeight: 400,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.js'),
  },
  autoHideMenuBar: true,
};

function createWindow() {
  win = new BrowserWindow(monacoSettings);
  win.webContents.on('did-finish-load', sendMonacoSettings);
  win.loadFile(path.join(__dirname, '..', 'index.html'));
  win.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function handleThemeChange() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors);
  }
}

nativeTheme.on('updated', handleThemeChange);

function sendMonacoSettings() {
  const monacorcPath = path.join(__dirname, '..', 'monacorc.json');
  const monacorcContent = fs.readFileSync(monacorcPath, 'utf-8');
  const monacorcSettings = JSON.parse(monacorcContent);

  const configs = {
    ...monacorcSettings,
    theme: nativeTheme.shouldUseDarkColors ? 'vs-dark' : 'vs-light',
  };
  win.webContents.send('monaco-settings', configs);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  nativeTheme.removeListener('updated', handleThemeChange);
});

// 新しいイベントリスナーを追加
ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});
