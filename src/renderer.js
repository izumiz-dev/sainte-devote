require.config({ paths: { vs: "node_modules/monaco-editor/min/vs" } });

let editor;

require(["vs/editor/editor.main"], function () {
  window.electron.receive("monaco-settings", (settings) => {
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

    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
      () => {
        editor.trigger("", "editor.action.quickCommand", null);
      }
    );

    window.electron.receive("theme-changed", (isDark) => {
      const theme = isDark ? "vs-dark" : "vs-light";
      monaco.editor.setTheme(theme);
      updateBodyTheme(isDark);
    });

    window.addEventListener("resize", function () {
      editor.layout();
    });
  });
});

function updateBodyTheme(isDark) {
  document.body.classList.remove("dark-theme", "light-theme");
  document.body.classList.add(isDark ? "dark-theme" : "light-theme");
}

document.getElementById("minimize-button").addEventListener("click", () => {
  window.electron.send("minimize-window");
});
