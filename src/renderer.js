require.config({ paths: { vs: "node_modules/monaco-editor/min/vs" } });

let editor;

require(["vs/editor/editor.main"], function () {
  // メインプロセスから設定を受け取る
  window.electron.receive("monaco-settings", (settings) => {
    editor = monaco.editor.create(document.getElementById("container"), {
      ...settings,
      scrollbar: {
        vertical: "hidden",
        horizontal: "hidden",
      },
    });

    // 初期テーマを設定
    updateBodyTheme(settings.theme === "vs-dark");

    // テーマ変更のリスナー
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
