require.config({ paths: { vs: "node_modules/monaco-editor/min/vs" } });

let editor;

function initializeEditor(settings) {
  editor = monaco.editor.create(document.getElementById("container"), {
    ...settings,
    scrollbar: {
      vertical: "hidden",
      horizontal: "hidden",
    },
  });

  loadSavedContent();
  setupContentSaving();
  updateBodyTheme(settings.theme === "vs-dark");
  setupKeyboardShortcuts();
  setupThemeChangeListener();
  setupWindowResizeListener();
}

function loadSavedContent() {
  const savedContent = localStorage.getItem("editorContent");
  if (savedContent) {
    editor.setValue(savedContent);
  }
}

function setupContentSaving() {
  editor.onDidChangeModelContent(() => {
    localStorage.setItem("editorContent", editor.getValue());
  });
}

function setupKeyboardShortcuts() {
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
    () => {
      editor.trigger("", "editor.action.quickCommand", null);
    }
  );
}

function setupThemeChangeListener() {
  window.electron.receive("theme-changed", (isDark) => {
    const theme = isDark ? "vs-dark" : "vs-light";
    monaco.editor.setTheme(theme);
    updateBodyTheme(isDark);
  });
}

function setupWindowResizeListener() {
  window.addEventListener("resize", () => editor.layout());
}

function updateBodyTheme(isDark) {
  document.body.classList.remove("dark-theme", "light-theme");
  document.body.classList.add(isDark ? "dark-theme" : "light-theme");
}

require(["vs/editor/editor.main"], function () {
  window.electron.receive("monaco-settings", initializeEditor);
});

document.getElementById("minimize-button").addEventListener("click", () => {
  window.electron.send("minimize-window");
});

document.getElementById("close-button").addEventListener("click", () => {
  window.electron.send("close-window");
});
