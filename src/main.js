const {
  app,
  BrowserWindow,
  nativeTheme,
  shell,
  ipcMain,
  dialog,
  Menu
} = require('electron');

const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');

let win;

const isDev = process.env.NODE_ENV === 'development';

// Only open external URLs with a safe, expected protocol. shell.openExternal
// can launch local files / handlers (e.g. file://, UNC paths) which a
// compromised renderer could abuse, so restrict it to web/mail links.
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function openExternalSafely(url) {
  if (typeof url !== 'string') return;
  try {
    const { protocol } = new URL(url);
    if (ALLOWED_EXTERNAL_PROTOCOLS.has(protocol)) {
      shell.openExternal(url);
    } else {
      console.warn(`Blocked openExternal for disallowed protocol: ${protocol}`);
    }
  } catch {
    console.warn(`Blocked openExternal for invalid URL: ${url}`);
  }
}

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
  width: 1000,
  height: 700,
  minWidth: 600,
  minHeight: 500,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.js'),
  },
  autoHideMenuBar: true,
  titleBarStyle: 'hidden',
  titleBarOverlay: {
    color: '#f9fafb',
    symbolColor: '#374151',
    height: 40
  }
};

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Export All Tabs (.zip)',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => {
            if (win) {
              win.webContents.send('request-export-all');
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [
            { type: 'separator' },
            { role: 'front' },
            { type: 'separator' },
            { role: 'window' }
          ]
          : [
            { role: 'close' }
          ])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function applyTitleBarOverlay(isDark) {
  if (process.platform === 'win32' && win && !win.isDestroyed()) {
    win.setTitleBarOverlay({
      color: isDark ? '#111827' : '#f9fafb',
      symbolColor: isDark ? '#9ca3af' : '#374151',
    });
  }
}

function createWindow() {
  win = new BrowserWindow(monacoSettings);

  createMenu();

  win.webContents.on('did-finish-load', sendMonacoSettings);
  win.loadFile(path.join(__dirname, '..', 'index.html'));

  const isDark = nativeTheme.shouldUseDarkColors;
  win.webContents.send('theme-changed', isDark);
  applyTitleBarOverlay(isDark);

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
    openExternalSafely(url);
    return { action: 'deny' };
  });
}

function handleThemeChange() {
  if (win && !win.isDestroyed()) {
    const isDark = nativeTheme.shouldUseDarkColors;
    win.webContents.send('theme-changed', isDark);
    applyTitleBarOverlay(isDark);
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

ipcMain.on('open-external', (event, url) => {
  openExternalSafely(url);
});

// The renderer owns the effective theme (system / light / dark override),
// so it tells the main process which titlebar overlay colors to apply.
ipcMain.on('set-title-bar-theme', (event, isDark) => {
  applyTitleBarOverlay(isDark);
});

ipcMain.on('save-file', async (event, { content, fileName }) => {
  try {
    const result = await dialog.showSaveDialog(win, {
      title: 'Markdownファイルを保存',
      defaultPath: fileName,
      filters: [
        { name: 'Markdown Files', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, content, 'utf8');
      event.reply('save-file-success', result.filePath);
    }
  } catch (error) {
    console.error('File save error:', error);
    event.reply('save-file-error', error.message);
  }
});

ipcMain.on('export-tabs-data', async (event, tabsData) => {
  try {
    const zip = new JSZip();

    tabsData.forEach(tab => {
      zip.file(tab.filename, tab.content);
    });

    const content = await zip.generateAsync({ type: 'nodebuffer' });

    const now = new Date();
    const dateStr = now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
    const defaultFileName = `sainte_devote_${dateStr}.zip`;

    const result = await dialog.showSaveDialog(win, {
      title: 'Save All Tabs as Zip',
      defaultPath: defaultFileName,
      filters: [
        { name: 'Zip Files', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, content);
      event.reply('save-file-success', result.filePath);
    }
  } catch (error) {
    console.error('Zip export error:', error);
    event.reply('save-file-error', error.message);
  }
});
