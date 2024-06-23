const { app, BrowserWindow, nativeTheme, Menu, ipcMain } = require("electron");

const path = require("path");
const fs = require("fs");

let win;

function createWindow() {
  if (win) {
    restoreExistingWindow();
    return;
  }

  win = new BrowserWindow(getWindowOptions());
  setupWindowEventListeners();
  setupMenu();
  loadContent();
  setupTheme();
  setupMenu();
}

function restoreExistingWindow() {
  if (win.isMinimized()) win.restore();
  win.focus();
}

function getWindowOptions() {
  return {
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
    enableMenuItemShortcuts: true,
  };
}

function setupWindowEventListeners() {
  win.webContents.on("before-input-event", handleKeyboardShortcuts);
  win.webContents.on("did-finish-load", sendMonacoSettings);
}

function handleKeyboardShortcuts(event, input) {
  if (input.type === "keyDown") {
    const isCloseCommand =
      (process.platform === "darwin" && input.meta && input.key === "w") ||
      (process.platform !== "darwin" && input.control && input.key === "w");

    if (isCloseCommand) {
      win.minimize();
      event.preventDefault();
    }
  }
}

function setupMenu() {
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
}

function loadContent() {
  win.loadFile(path.join(__dirname, "..", "index.html"));
}

function setupTheme() {
  nativeTheme.on("updated", () => {
    win.webContents.send("theme-changed", nativeTheme.shouldUseDarkColors);
  });

  win.webContents.send("theme-changed", nativeTheme.shouldUseDarkColors);
}

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

function setupMenu() {
  const template = [
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Developer",
      submenu: [{ role: "toggleDevTools" }],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  if (process.env.NODE_ENV === "development") {
    win.webContents.openDevTools();
  }
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

ipcMain.on("close-window", () => {
  app.quit();
});

ipcMain.on("minimize-window", () => {
  win.minimize();
});
