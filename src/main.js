const { app, BrowserWindow, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 400,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.removeMenu();

  win.loadFile(path.join(__dirname, "..", "index.html"));

  // monacorc.jsonを読み込む
  const monacorcPath = path.join(__dirname, "..", "monacorc.json");
  const monacorcContent = fs.readFileSync(monacorcPath, "utf-8");
  const monacorcSettings = JSON.parse(monacorcContent);

  const isDarkMode = nativeTheme.shouldUseDarkColors;

  // 設定をレンダラープロセスに送信
  win.webContents.on("did-finish-load", () => {
    const theme = {
      theme: isDarkMode ? "vs-dark" : "vs-light",
    };
    const configs = Object.assign(monacorcSettings, theme);
    win.webContents.send("monaco-settings", configs);
  });

  // システムテーマの変更を監視
  nativeTheme.on("updated", () => {
    win.webContents.send("theme-changed", nativeTheme.shouldUseDarkColors);
  });

  // 初期テーマを設定
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
