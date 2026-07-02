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
const isLinux = process.platform === 'linux';
const filePathsToOpen = [];
const activeFilePaths = new Set();

const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

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

function isAllowedExtension(filePath) {
  return ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function validateReadableFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return null;
  }
  const resolved = path.resolve(filePath);
  if (resolved.startsWith('\\\\') || resolved.startsWith('//')) {
    return null;
  }
  if (!isAllowedExtension(resolved)) return null;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

function validateWritableFilePath(filePath, { allowNewExtension = false } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return null;
  }
  let resolved = path.resolve(filePath);
  if (resolved.startsWith('\\\\') || resolved.startsWith('//')) {
    return null;
  }
  if (!isAllowedExtension(resolved)) {
    if (!allowNewExtension) return null;
    resolved = resolved + '.md';
  }
  const parent = path.dirname(resolved);
  try {
    if (!fs.existsSync(parent)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function readFileContent(filePath) {
  const safePath = validateReadableFilePath(filePath);
  if (!safePath) return null;
  try {
    return fs.readFileSync(safePath, 'utf8');
  } catch (error) {
    console.error('Failed to read file:', error);
    return null;
  }
}

function extractFilePathsFromArgv(argv) {
  const startIndex = isDev ? 2 : 1;
  return argv
    .slice(startIndex)
    .filter(arg => !arg.startsWith('-'))
    .map(arg => validateReadableFilePath(arg))
    .filter(Boolean);
}

function openFileInRenderer(filePath) {
  const safePath = validateReadableFilePath(filePath);
  if (!safePath || !win || win.isDestroyed()) return;

  const content = readFileContent(safePath);
  if (content === null) return;

  activeFilePaths.add(safePath);
  win.webContents.send('file-opened', { filePath: safePath, content });
  app.addRecentDocument(safePath);
}

function sendMenuAction(action) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('menu-action', action);
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
  titleBarStyle: isLinux ? 'default' : 'hidden',
  ...(isLinux ? { frame: true } : {
    titleBarOverlay: {
      color: '#f9fafb',
      symbolColor: '#374151',
      height: 40
    }
  }),
};

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new-tab'),
        },
        {
          label: 'Open File...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('open-file'),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('save'),
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendMenuAction('save-as'),
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendMenuAction('close-tab'),
        },
        { type: 'separator' },
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

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalSafely(url);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

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
    platform: process.platform,
    useNativeTitleBar: isLinux,
  };
  win.webContents.send('monaco-settings', configs);
}

let hasProcessedStartupFiles = false;

function processPendingFileOpens() {
  if (!win || win.isDestroyed() || hasProcessedStartupFiles) return;
  hasProcessedStartupFiles = true;

  const argvPaths = extractFilePathsFromArgv(process.argv);
  const allPaths = [...filePathsToOpen, ...argvPaths];
  filePathsToOpen.length = 0;

  const seen = new Set();
  allPaths.forEach(fp => {
    if (!seen.has(fp)) {
      seen.add(fp);
      openFileInRenderer(fp);
    }
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePaths = extractFilePathsFromArgv(argv);
    filePaths.forEach(fp => openFileInRenderer(fp));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  if (process.platform === 'darwin') {
    app.on('open-file', (event, filePath) => {
      event.preventDefault();
      const safePath = validateReadableFilePath(filePath);
      if (!safePath) return;
      if (win && !win.isDestroyed()) {
        openFileInRenderer(safePath);
      } else {
        filePathsToOpen.push(safePath);
      }
    });
  }

  app.whenReady().then(() => {
    createWindow();
    win.webContents.on('did-finish-load', processPendingFileOpens);
  });
}

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

ipcMain.on('set-title-bar-theme', (event, isDark) => {
  applyTitleBarOverlay(isDark);
});

ipcMain.handle('open-file-dialog', async () => {
  try {
    const result = await dialog.showOpenDialog(win, {
      filters: [
        { name: 'Markdown Files', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    });

    if (result.canceled || !result.filePaths.length) {
      return [];
    }

    const files = [];
    for (const filePath of result.filePaths) {
      const safePath = validateReadableFilePath(filePath);
      if (!safePath) continue;
      const content = readFileContent(safePath);
      if (content !== null) {
        activeFilePaths.add(safePath);
        files.push({ filePath: safePath, content });
        app.addRecentDocument(safePath);
      }
    }
    return files;
  } catch (error) {
    console.error('Open file dialog error:', error);
    return [];
  }
});

ipcMain.on('save-file-to-path', (event, { filePath, content }) => {
  try {
    const safePath = validateWritableFilePath(filePath);
    if (!safePath || typeof content !== 'string') {
      event.reply('save-file-error', 'Invalid file path');
      return;
    }
    if (!activeFilePaths.has(safePath)) {
      event.reply('save-file-error', 'Unauthorized file path access');
      return;
    }
    fs.writeFileSync(safePath, content, 'utf8');
    app.addRecentDocument(safePath);
  } catch (error) {
    console.error('Autosave error:', error);
    event.reply('save-file-error', error.message);
  }
});

ipcMain.on('close-file', (event, filePath) => {
  if (typeof filePath === 'string') {
    const safePath = path.resolve(filePath);
    activeFilePaths.delete(safePath);
  }
});

ipcMain.on('open-dropped-file', (event, filePath) => {
  openFileInRenderer(filePath);
});

ipcMain.on('update-window-title', (event, { title, filePath }) => {
  if (win && !win.isDestroyed() && typeof title === 'string') {
    win.setTitle(title);
    if (process.platform === 'darwin') {
      win.setRepresentedFilename(filePath || '');
    }
  }
});

ipcMain.on('save-file', async (event, { content, fileName }) => {
  try {
    const result = await dialog.showSaveDialog(win, {
      title: 'Save Markdown File',
      defaultPath: fileName,
      filters: [
        { name: 'Markdown Files', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      const writePath = validateWritableFilePath(result.filePath, { allowNewExtension: true });
      if (!writePath) {
        event.reply('save-file-error', 'Invalid file path');
        return;
      }
      fs.writeFileSync(writePath, content, 'utf8');
      activeFilePaths.add(writePath);
      app.addRecentDocument(writePath);
      event.reply('save-file-success', writePath);
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
      let safeFilename = path.basename(tab.filename);
      if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
        safeFilename = `tab_${tab.id || Date.now()}.md`;
      }
      // Ensure it has an allowed extension to block malicious formats
      if (!isAllowedExtension(safeFilename)) {
        safeFilename += '.md';
      }
      zip.file(safeFilename, tab.content);
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