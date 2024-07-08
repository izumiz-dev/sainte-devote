const { app, BrowserWindow, nativeTheme } = require("electron");

const path = require("path");
const fs = require("fs");

let win;

const monacoSettings = {
  width: 400,
  height: 600,
  minWidth: 400,
  minHeight: 400,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, "preload.js"),
  },
  autoHideMenuBar: true,
};

function createWindow() {
  win = new BrowserWindow(monacoSettings);
  win.webContents.on("did-finish-load", sendMonacoSettings);
  win.loadFile(path.join(__dirname, "..", "index.html"));
  win.webContents.send("theme-changed", nativeTheme.shouldUseDarkColors);

  win.on('closed', () => {
    win = null;
  });
}

function handleThemeChange() {
  if (win && !win.isDestroyed()) {
    win.webContents.send("theme-changed", nativeTheme.shouldUseDarkColors);
  }
}

nativeTheme.on("updated", handleThemeChange);

function sendMonacoSettings() {
  const monacorcPath = path.join(__dirname, "..", "monacorc.json");
  const monacorcContent = fs.readFileSync(monacorcPath, "utf-8");
  const monacorcSettings = JSON.parse(monacorcContent);

  const configs = {
    ...monacorcSettings,
    theme: nativeTheme.shouldUseDarkColors ? "vs-dark" : "vs-light",
  };
  win.webContents.send("monaco-settings", configs);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('before-quit', () => {
  nativeTheme.removeListener("updated", handleThemeChange);
});