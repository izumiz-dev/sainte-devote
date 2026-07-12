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
const crypto = require('crypto');
const JSZip = require('jszip');

const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
// O_NOFOLLOW is undefined on some platforms; fall back to 0 so the flag is a no-op
// rather than corrupting the bitmask with NaN.
const NOFOLLOW = O_NOFOLLOW || 0;

// Opens with O_NOFOLLOW so a symlink swapped in after path validation (TOCTOU)
// makes the open() call itself fail instead of silently following the link.
function readFileNoFollow(safePath) {
  let fd;
  try {
    fd = fs.openSync(safePath, O_RDONLY | NOFOLLOW);
    return fs.readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeFileNoFollow(safePath, data, encoding = 'utf8') {
  let fd;
  try {
    fd = fs.openSync(safePath, O_WRONLY | O_CREAT | O_TRUNC | NOFOLLOW, 0o666);
    if (encoding === null) fs.writeFileSync(fd, data);
    else fs.writeFileSync(fd, data, encoding);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

let win;

const isDev = process.env.NODE_ENV === 'development';
const isLinux = process.platform === 'linux';
const filePathsToOpen = [];
const activeFilePaths = new Set();
const MAX_RECENT_FILES = 10;
let recentFilePaths = [];

const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const EXPORT_EXTENSIONS = new Set(['.zip']);

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

function isBlockedUncPath(resolvedPath) {
  return resolvedPath.startsWith('\\\\') || resolvedPath.startsWith('//');
}

function pathContainsSymlink(resolvedPath) {
  const normalized = path.resolve(resolvedPath);
  const { root } = path.parse(normalized);
  const parts = path.relative(root, normalized).split(path.sep).filter(Boolean);
  let current = root;

  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch {
      if (i < parts.length - 1) {
        return false;
      }
      break;
    }
  }

  return false;
}

function validateReadableFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return null;
  }
  const resolved = path.resolve(filePath);
  if (isBlockedUncPath(resolved)) {
    return null;
  }
  if (!isAllowedExtension(resolved)) return null;
  if (pathContainsSymlink(resolved)) return null;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
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
  if (isBlockedUncPath(resolved)) {
    return null;
  }
  if (!isAllowedExtension(resolved)) {
    if (!allowNewExtension) return null;
    resolved = resolved + '.md';
  }
  if (pathContainsSymlink(resolved)) return null;
  const parent = path.dirname(resolved);
  try {
    if (!fs.existsSync(parent)) return null;
    if (fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

function validateExportFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return null;
  }
  const resolved = path.resolve(filePath);
  if (isBlockedUncPath(resolved)) {
    return null;
  }
  if (!EXPORT_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return null;
  }
  if (pathContainsSymlink(resolved)) return null;
  const parent = path.dirname(resolved);
  try {
    if (!fs.existsSync(parent)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function getRecentFilesPath() {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

function loadRecentFilesFromDisk() {
  try {
    const raw = fs.readFileSync(getRecentFilesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    recentFilePaths = parsed
      .filter((entry) => typeof entry === 'string')
      .map((entry) => validateReadableFilePath(entry))
      .filter(Boolean)
      .slice(0, MAX_RECENT_FILES);
  } catch {
    recentFilePaths = [];
  }
}

function saveRecentFilesToDisk() {
  try {
    fs.writeFileSync(
      getRecentFilesPath(),
      JSON.stringify(recentFilePaths, null, 2),
      'utf8',
    );
  } catch (error) {
    console.error('Failed to persist recent files:', error);
  }
}

function addToRecentFiles(filePath) {
  const safePath = validateReadableFilePath(filePath);
  if (!safePath) return;
  recentFilePaths = [
    safePath,
    ...recentFilePaths.filter((entry) => entry !== safePath),
  ].slice(0, MAX_RECENT_FILES);
  saveRecentFilesToDisk();
}

function isTrackedRecentFile(filePath) {
  const safePath = validateReadableFilePath(filePath);
  return Boolean(safePath && recentFilePaths.includes(safePath));
}

function removeFromActiveFilePaths(filePath) {
  const safePath = validateReadableFilePath(filePath);
  if (safePath) {
    activeFilePaths.delete(safePath);
    return;
  }
  if (typeof filePath === 'string') {
    activeFilePaths.delete(path.resolve(filePath));
  }
}

function getRepresentedFilename(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const safePath = validateReadableFilePath(filePath);
  if (!safePath || !activeFilePaths.has(safePath)) return '';
  return safePath;
}

function readFileContent(filePath) {
  const safePath = validateReadableFilePath(filePath);
  if (!safePath) return null;
  try {
    return readFileNoFollow(safePath);
  } catch (error) {
    console.error('Failed to read file:', error);
    return null;
  }
}

// --- External change detection ---
//
// Files opened in a tab are watched so edits made in another program (VS
// Code, vim, etc.) are reflected here instead of being silently clobbered by
// our own 300ms autosave. We watch the parent *directory* rather than the
// file itself: editors that save atomically (write a temp file, then rename
// over the target) replace the inode, which ends a direct file watch on most
// platforms. Directory watches survive that and work uniformly across
// FSEvents (macOS), ReadDirectoryChangesW (Windows) and inotify (Linux).
const watchedFiles = new Map(); // safePath -> { dir, base }
const dirWatchers = new Map(); // dir -> FSWatcher
const lastKnownContentHashes = new Map(); // safePath -> sha256 hex
const pendingChangeChecks = new Map(); // safePath -> Timeout
const CHANGE_CHECK_DEBOUNCE_MS = 200;
const CHANGE_CHECK_RETRY_DELAY_MS = 100;

function hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// Records what we just read/wrote so the next watcher event (very likely our
// own save, or an editor's redundant no-op save) can be recognized and
// ignored instead of round-tripped to the renderer.
function rememberFileContent(safePath, content) {
  lastKnownContentHashes.set(safePath, hashContent(content));
}

function basenameForCompare(filePath) {
  const base = path.basename(filePath);
  // Watch event filenames are compared case-insensitively on the platforms
  // whose default filesystems are case-insensitive.
  return process.platform === 'darwin' || process.platform === 'win32'
    ? base.toLowerCase()
    : base;
}

function scheduleExternalChangeCheck(safePath) {
  clearTimeout(pendingChangeChecks.get(safePath));
  pendingChangeChecks.set(
    safePath,
    setTimeout(() => {
      pendingChangeChecks.delete(safePath);
      checkFileForExternalChange(safePath);
    }, CHANGE_CHECK_DEBOUNCE_MS),
  );
}

function checkFileForExternalChange(safePath, attempt = 0) {
  if (!watchedFiles.has(safePath) || !win || win.isDestroyed()) return;

  // Re-validate before every read, like every other fs access in this file —
  // a parent directory swapped for a symlink (or the file replaced by a
  // non-regular file) after watch time would otherwise slip past O_NOFOLLOW.
  if (!validateReadableFilePath(safePath)) {
    if (!fs.existsSync(safePath)) {
      if (lastKnownContentHashes.has(safePath)) {
        lastKnownContentHashes.delete(safePath);
        win.webContents.send('file-removed-externally', { filePath: safePath });
      }
    }
    // Present but invalid: never read it.
    return;
  }

  let content;
  try {
    content = readFileNoFollow(safePath);
  } catch (error) {
    // Likely a transient lock from the writing process (common on Windows).
    // Retry a couple of times before giving up on this event.
    if (attempt < 2) {
      setTimeout(
        () => checkFileForExternalChange(safePath, attempt + 1),
        CHANGE_CHECK_RETRY_DELAY_MS,
      );
    } else {
      console.error('Failed to read externally-changed file:', error);
    }
    return;
  }

  const newHash = hashContent(content);
  if (lastKnownContentHashes.get(safePath) === newHash) return;

  lastKnownContentHashes.set(safePath, newHash);
  win.webContents.send('file-changed-externally', { filePath: safePath, content });
}

function handleDirWatchEvent(dir, eventFilename) {
  const targetBase = eventFilename ? basenameForCompare(eventFilename) : null;
  for (const [safePath, info] of watchedFiles) {
    if (info.dir !== dir) continue;
    // Some platforms omit the filename on certain events; when that happens
    // fall back to checking every watched file in this directory.
    if (targetBase !== null && basenameForCompare(info.base) !== targetBase) continue;
    scheduleExternalChangeCheck(safePath);
  }
}

function watchFileForExternalChanges(safePath) {
  if (watchedFiles.has(safePath)) return;

  const dir = path.dirname(safePath);
  watchedFiles.set(safePath, { dir, base: path.basename(safePath) });

  if (dirWatchers.has(dir)) return;
  try {
    const watcher = fs.watch(dir, (_eventType, filename) => {
      handleDirWatchEvent(dir, filename);
    });
    watcher.on('error', (error) => {
      // Removable/network drives can start failing mid-session; drop the
      // watcher and rely on the focus-triggered fallback check instead.
      console.warn(`File watcher error for ${dir}:`, error.message);
      watcher.close();
      dirWatchers.delete(dir);
    });
    dirWatchers.set(dir, watcher);
  } catch (error) {
    // Focus-triggered rechecks still cover this file.
    console.warn(`Failed to watch directory ${dir}:`, error.message);
  }
}

function unwatchFile(filePath) {
  if (typeof filePath !== 'string') return;
  const safePath = validateReadableFilePath(filePath) || path.resolve(filePath);
  const info = watchedFiles.get(safePath);
  if (!info) return;

  watchedFiles.delete(safePath);
  lastKnownContentHashes.delete(safePath);
  clearTimeout(pendingChangeChecks.get(safePath));
  pendingChangeChecks.delete(safePath);

  // Close the directory watcher only when no other watched file shares the
  // directory. Derived from watchedFiles itself (rather than a refcount)
  // so it cannot drift when fs.watch failed for one of the files.
  for (const other of watchedFiles.values()) {
    if (other.dir === info.dir) return;
  }
  const watcher = dirWatchers.get(info.dir);
  if (watcher) {
    watcher.close();
    dirWatchers.delete(info.dir);
  }
}

function recheckAllWatchedFiles() {
  for (const safePath of watchedFiles.keys()) {
    scheduleExternalChangeCheck(safePath);
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

function openFileInRenderer(filePath, { grantWriteAccess = true } = {}) {
  const safePath = validateReadableFilePath(filePath);
  if (!safePath || !win || win.isDestroyed()) return;

  const content = readFileContent(safePath);
  if (content === null) return;

  if (grantWriteAccess) activeFilePaths.add(safePath);
  addToRecentFiles(safePath);
  rememberFileContent(safePath, content);
  watchFileForExternalChanges(safePath);
  win.webContents.send('file-opened', { filePath: safePath, content, readOnly: !grantWriteAccess });
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
    sandbox: true,
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
  // A (re)load wipes the renderer's IPC listeners; hold queued file opens
  // until it reports ready again.
  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
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
// 'file-opened' sent before the renderer's IPC listeners exist is silently
// dropped, and those listeners are only registered after Monaco's AMD modules
// finish loading — later than did-finish-load. So queued opens are flushed
// only once the renderer says it is ready.
let rendererReady = false;

function flushPendingFileOpens() {
  if (!rendererReady || !win || win.isDestroyed()) return;

  const seen = new Set();
  filePathsToOpen.splice(0).forEach(fp => {
    if (!seen.has(fp)) {
      seen.add(fp);
      openFileInRenderer(fp);
    }
  });
}

function showAndFocusWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  if (!hasProcessedStartupFiles) {
    hasProcessedStartupFiles = true;
    filePathsToOpen.push(...extractFilePathsFromArgv(process.argv));
  }
  flushPendingFileOpens();
});

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    filePathsToOpen.push(...extractFilePathsFromArgv(argv));
    if (!win || win.isDestroyed()) {
      if (app.isReady()) createWindow();
    } else {
      flushPendingFileOpens();
    }
    showAndFocusWindow();
  });

  if (process.platform === 'darwin') {
    app.on('open-file', (event, filePath) => {
      event.preventDefault();
      const safePath = validateReadableFilePath(filePath);
      if (!safePath) return;
      filePathsToOpen.push(safePath);
      // Before app ready: whenReady creates the window and the renderer's
      // ready signal flushes the queue.
      if (!app.isReady()) return;
      if (!win || win.isDestroyed()) {
        // App alive in the Dock with all windows closed.
        createWindow();
      } else {
        flushPendingFileOpens();
      }
      showAndFocusWindow();
    });
  }

  app.whenReady().then(() => {
    loadRecentFilesFromDisk();
    createWindow();
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

// Directory watchers can miss events (system sleep, network drives), so
// re-check everything whenever the window regains focus as a safety net —
// the same belt-and-suspenders approach editors like VS Code use.
app.on('browser-window-focus', recheckAllWatchedFiles);

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
        addToRecentFiles(safePath);
        rememberFileContent(safePath, content);
        watchFileForExternalChanges(safePath);
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
    writeFileNoFollow(safePath, content);
    addToRecentFiles(safePath);
    rememberFileContent(safePath, content);
    app.addRecentDocument(safePath);
  } catch (error) {
    console.error('Autosave error:', error);
    event.reply('save-file-error', error.message);
  }
});

ipcMain.on('close-file', (event, filePath) => {
  removeFromActiveFilePaths(filePath);
  unwatchFile(filePath);
});

ipcMain.handle('open-dropped-files', async (_event, filePaths) => {
  if (!Array.isArray(filePaths)) return [];

  const opened = [];
  for (const filePath of filePaths) {
    const safePath = validateReadableFilePath(filePath);
    if (!safePath) continue;
    openFileInRenderer(safePath);
    opened.push(safePath);
  }
  return opened;
});

ipcMain.handle('get-recent-files', async () => [...recentFilePaths]);

ipcMain.handle('open-recent-file', async (_event, filePath) => {
  if (!isTrackedRecentFile(filePath)) {
    return { ok: false, reason: 'File is not in the recent list' };
  }
  // Recent-file reopen is reachable from the renderer without a fresh user
  // file-selection gesture (dialog / drag-drop / argv), so it must not grant
  // silent overwrite access. The tab opens read-only until promoted via Save As.
  openFileInRenderer(filePath, { grantWriteAccess: false });
  return { ok: true };
});

ipcMain.on('update-window-title', (event, { title, filePath }) => {
  if (win && !win.isDestroyed() && typeof title === 'string') {
    win.setTitle(title);
    if (process.platform === 'darwin') {
      win.setRepresentedFilename(getRepresentedFilename(filePath));
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
      writeFileNoFollow(writePath, content);
      activeFilePaths.add(writePath);
      addToRecentFiles(writePath);
      rememberFileContent(writePath, content);
      watchFileForExternalChanges(writePath);
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
      const writePath = validateExportFilePath(result.filePath);
      if (!writePath) {
        event.reply('save-file-error', 'Invalid export path');
        return;
      }
      writeFileNoFollow(writePath, content, null);
      event.reply('save-file-success', writePath);
    }
  } catch (error) {
    console.error('Zip export error:', error);
    event.reply('save-file-error', error.message);
  }
});