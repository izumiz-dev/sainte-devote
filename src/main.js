const { app, BrowserWindow, nativeTheme, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");

let win;

function createWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 400,
    height: 600,
    minWidth: 400,
    minHeight: 400,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    frame: false,
  });

  globalShortcut.register("CommandOrControl+W", () => {
    win.close();
  });

  const { Menu } = require("electron");
  const menu = Menu.buildFromTemplate([
    {
      label: "Developer",
      submenu: [{ role: "toggleDevTools" }],
    },
  ]);
  Menu.setApplicationMenu(menu);

  if (process.env.NODE_ENV === "development") {
    win.webContents.openDevTools();
  }

  win.removeMenu();

  win.loadFile(path.join(__dirname, "..", "index.html"));

  const monacorcPath = path.join(__dirname, "..", "monacorc.json");
  const monacorcContent = fs.readFileSync(monacorcPath, "utf-8");
  const monacorcSettings = JSON.parse(monacorcContent);

  const isDarkMode = nativeTheme.shouldUseDarkColors;

  win.webContents.on("did-finish-load", () => {
    const theme = {
      theme: isDarkMode ? "vs-dark" : "vs-light",
    };
    const configs = Object.assign(monacorcSettings, theme);
    win.webContents.send("monaco-settings", configs);
  });

  nativeTheme.on("updated", () => {
    win.webContents.send("theme-changed", nativeTheme.shouldUseDarkColors);
  });

  win.webContents.send("theme-changed", nativeTheme.shouldUseDarkColors);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
