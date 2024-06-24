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

  const savedContent = localStorage.getItem("editorContent");
  if (savedContent) {
    editor.setValue(savedContent);
  }

  editor.onDidChangeModelContent(() => {
    localStorage.setItem("editorContent", editor.getValue());
  });

  updateBodyTheme(settings.theme === "vs-dark");
  window.electron.receive("theme-changed", (isDark) => {
    const theme = isDark ? "vs-dark" : "vs-light";
    monaco.editor.setTheme(theme);
    updateBodyTheme(isDark);
  });

  window.addEventListener("resize", () => editor.layout());
}

function updateBodyTheme(isDark) {
  document.body.classList.remove("dark-theme", "light-theme");
  document.body.classList.add(isDark ? "dark-theme" : "light-theme");
}

require(["vs/editor/editor.main"], function () {
  window.electron.receive("monaco-settings", initializeEditor);
});
