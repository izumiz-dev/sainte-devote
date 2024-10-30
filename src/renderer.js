require.config({
  paths: {
    vs: "node_modules/monaco-editor/min/vs",
    marked: "node_modules/marked/marked.min",
  },
});

require(["vs/editor/editor.main", "marked"], function (_, marked) {
  // 非推奨の機能を無効化
  marked.setOptions({
    mangle: false,
    headerIds: false,
  });

  let editor;
  let isPreview = false;

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

    previewContainer.classList.remove("markdown-light", "markdown-dark");
    previewContainer.classList.add(isDark ? "markdown-dark" : "markdown-light");

    const markdownCssLink = document.getElementById("github-markdown-css");
    if (isDark) {
      markdownCssLink.href =
        "node_modules/github-markdown-css/github-markdown-dark.css";
    } else {
      markdownCssLink.href =
        "node_modules/github-markdown-css/github-markdown-light.css";
    }
  }

  function toggleMode() {
    isPreview = !isPreview;
    if (isPreview) {
      const markdownContent = editor.getValue();
      const htmlContent = marked.parse(markdownContent);
      previewContainer.innerHTML = htmlContent;
      editorContainer.style.display = "none";
      previewContainer.style.display = "block";

      // プレビューモードでリンクをクリックしたときに既定のブラウザで開く
      previewContainer.querySelectorAll("a").forEach((link) => {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          window.electron.send("open-external", link.href);
        });
      });
    } else {
      previewContainer.style.display = "none";
      editorContainer.style.display = "block";
    }
  }

  const editorContainer = document.getElementById("container");
  const previewContainer = document.getElementById("preview");
  previewContainer.style.display = "none";

  document
    .getElementById("mode-switch-btn")
    .addEventListener("click", toggleMode);

  window.electron.receive("monaco-settings", initializeEditor);
  window.electron.receive("theme-changed", (isDark) => {
    updateBodyTheme(isDark);
  });
});
