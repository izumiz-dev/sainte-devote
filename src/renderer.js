require.config({
  paths: {
    vs: 'node_modules/monaco-editor/min/vs',
    marked: 'node_modules/marked/marked.min',
  },
});

require(['vs/editor/editor.main', 'marked'], function (_, marked) {
  marked.setOptions({
    mangle: false,
    headerIds: false,
  });

  const editors = {};
  let currentTab = null;
  let tabCount = 1;
  let isPreview = false;
  let monacoSettings;
  const tabData = {}; // タブ情報を保持
  const markdownCache = {}; // markdownのキャッシュを保持するオブジェクトを追加
  const initializedEditors = new Set(); // エディタの初期化状態を追跡

  // IndexedDBユーティリティ
  const dbName = 'SainteDevoteDB';
  let db;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(dbName, 1);

      request.onupgradeneeded = (event) => {
        db = event.target.result;
        if (!db.objectStoreNames.contains('tabs')) {
          db.createObjectStore('tabs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('content')) {
          db.createObjectStore('content', { keyPath: 'tabId' });
        }
      };

      request.onsuccess = (event) => {
        db = event.target.result;
        resolve();
      };

      request.onerror = (event) => {
        reject('Database error: ' + event.target.errorCode);
      };
    });
  }

  function saveTabDataIndexedDB() {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['tabs'], 'readwrite');
      const store = transaction.objectStore('tabs');

      // 既存のデータをクリア
      store.clear().onsuccess = () => {
        // 現在のタブデータを保存
        Object.entries(tabData).forEach(([id, tab]) => {
          store.put({
            id: Number(id),
            title: tab.title,
            content: tab.content || '',
          });
        });
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject('Transaction error');
    });
  }

  function loadTabDataIndexedDB() {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['tabs'], 'readonly');
      const store = transaction.objectStore('tabs');
      const request = store.getAll();

      request.onsuccess = (event) => {
        const tabs = event.target.result;
        tabs.forEach((tab) => {
          tabData[tab.id] = {
            title: tab.title,
            content: tab.content || '',
          };
          if (tab.id > tabCount) tabCount = tab.id;
        });
        resolve();
      };

      request.onerror = () => reject('Load error');
    });
  }

  function saveEditorContentIndexedDB(tabId, content) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['content'], 'readwrite');
      const store = transaction.objectStore('content');
      store.put({ tabId, content });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject('Transaction error');
    });
  }

  function loadEditorContentIndexedDB(tabId) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['content'], 'readonly');
      const store = transaction.objectStore('content');
      const request = store.get(tabId);

      request.onsuccess = (event) => {
        const result = event.target.result;
        resolve(result ? result.content : '');
      };

      request.onerror = () => reject('Load error');
    });
  }

  // IndexedDBからタブデータを削除する関数を修正
  function deleteTabDataIndexedDB(tabId) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['tabs'], 'readwrite');
      const store = transaction.objectStore('tabs');
      store.delete(Number(tabId));

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject('Delete tab data error');
    });
  }

  // IndexedDBからコンテンツを削除する関数を修正
  function deleteEditorContentIndexedDB(tabId) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['content'], 'readwrite');
      const store = transaction.objectStore('content');
      store.delete(Number(tabId));

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject('Delete content error');
    });
  }

  function initializeEditor(settings, tabId) {
    if (initializedEditors.has(tabId)) return;

    const container = document.querySelector(`.editor[data-tab="${tabId}"]`);
    if (!container) return;

    editors[tabId] = monaco.editor.create(container, {
      ...settings,
      scrollbar: {
        vertical: 'hidden',
        horizontal: 'hidden',
      },
    });

    loadEditorContentIndexedDB(tabId).then((savedContent) => {
      if (savedContent) {
        editors[tabId].setValue(savedContent);
      }
    });

    editors[tabId].onDidChangeModelContent(async () => {
      const content = editors[tabId].getValue();
      await saveEditorContentIndexedDB(tabId, content);
    });

    initializedEditors.add(tabId);
  }

  function updateBodyTheme(isDark) {
    document.body.classList.remove('dark-theme', 'light-theme');
    document.body.classList.add(isDark ? 'dark-theme' : 'light-theme');

    previewContainer.classList.remove('markdown-light', 'markdown-dark');
    previewContainer.classList.add(isDark ? 'markdown-dark' : 'markdown-light');

    const markdownCssLink = document.getElementById('github-markdown-css');
    if (isDark) {
      markdownCssLink.href =
        'node_modules/github-markdown-css/github-markdown-dark.css';
    } else {
      markdownCssLink.href =
        'node_modules/github-markdown-css/github-markdown-light.css';
    }

    // エディタのテーマを更新
    const newTheme = isDark ? 'vs-dark' : 'vs-light';
    monaco.editor.setTheme(newTheme);

    // 各エディタのオプションを更新
    Object.values(editors).forEach((editor) => {
      if (editor) {
        editor.updateOptions({ theme: newTheme });
      }
    });
  }

  function addTab(tabId = null, title = null, content = null) {
    // タブIDを確実に数値型にする
    tabId = tabId !== null ? Number(tabId) : ++tabCount;
    if (isNaN(tabId)) tabId = ++tabCount;

    title = title || `Tab ${tabId}`;

    const tabs = document.getElementById('tabs');
    const newTab = document.createElement('button');
    newTab.classList.add('tab');
    newTab.dataset.tab = tabId;

    // 閉じるボタンを追加
    const tabTitle = document.createElement('span');
    tabTitle.textContent = title;
    newTab.appendChild(tabTitle);

    const closeBtn = document.createElement('span');
    closeBtn.classList.add('close-tab-btn');
    closeBtn.textContent = '×';
    newTab.appendChild(closeBtn);

    tabs.insertBefore(newTab, document.querySelector('.add-tab-btn'));

    const editorContainer = document.getElementById('editor-container');
    const newEditor = document.createElement('div');
    newEditor.classList.add('editor');
    newEditor.dataset.tab = tabId;
    newEditor.style.display = 'none';
    editorContainer.appendChild(newEditor);

    // tabDataオブジェクトにidフィールドを追加
    tabData[tabId] = {
      id: tabId, // この行を追加
      title: title,
      content: content || '',
    };
    saveTabData();

    switchTab(tabId);
  }

  function getMarkdownHtml(content, tabId) {
    // キャッシュがあれば返す
    if (markdownCache[tabId] && markdownCache[tabId].content === content) {
      return markdownCache[tabId].html;
    }
    // キャッシュがなければparseして保存
    const html = marked.parse(content);
    markdownCache[tabId] = { content, html };
    return html;
  }

  function switchTab(tabId) {
    // タブIDを数値型に変換
    tabId = Number(tabId);
    if (isNaN(tabId)) return;

    // アクティブなタブのクラスを更新
    if (activeTabElement) {
      activeTabElement.classList.remove('active');
    }

    const newTab = document.querySelector(`.tab[data-tab="${tabId}"]`);
    newTab.classList.add('active');
    activeTabElement = newTab;

    // 現在のタブを非表示
    if (currentTab) {
      const currentEditor = document.querySelector(
        `.editor[data-tab="${currentTab}"]`,
      );
      if (currentEditor) {
        currentEditor.style.display = 'none';
      }
    }

    currentTab = tabId;

    // プレビューモードとエディタモードの切り替え
    if (isPreview) {
      const markdownContent = editors[currentTab]?.getValue() || '';
      const htmlContent = getMarkdownHtml(markdownContent, currentTab);
      if (previewContainer.innerHTML !== htmlContent) {
        previewContainer.innerHTML = htmlContent;
      }
      previewContainer.style.display = 'block';
      document.querySelector(`.editor[data-tab="${tabId}"]`).style.display =
        'none';
    } else {
      previewContainer.style.display = 'none';
      const editorElement = document.querySelector(
        `.editor[data-tab="${tabId}"]`,
      );
      editorElement.style.display = 'block';

      // エディタの初期化と表示を確実に行う
      initializeEditor(monacoSettings, tabId);
      if (editors[tabId]) {
        editors[tabId].layout();
      }
    }
  }

  async function initializeTabs() {
    await openDatabase();
    await loadTabDataIndexedDB();
    if (Object.keys(tabData).length > 0) {
      for (const tabId of Object.keys(tabData)) {
        const title = tabData[tabId].title;
        const content = await loadEditorContentIndexedDB(tabId);
        addTab(parseInt(tabId), title, content);
      }
    } else {
      addTab();
    }
  }

  function toggleMode() {
    isPreview = !isPreview;
    if (isPreview) {
      const markdownContent = editors[currentTab].getValue();
      const htmlContent = marked.parse(markdownContent);
      previewContainer.innerHTML = htmlContent;
      document.querySelector(
        `.editor[data-tab="${currentTab}"]`,
      ).style.display = 'none';
      previewContainer.style.display = 'block';
    } else {
      previewContainer.style.display = 'none';
      document.querySelector(
        `.editor[data-tab="${currentTab}"]`,
      ).style.display = 'block';
    }
  }

  async function saveTabData() {
    await saveTabDataIndexedDB();
  }

  const tabs = document.getElementById('tabs');
  const addTabBtn = document.querySelector('.add-tab-btn');
  const previewContainer = document.getElementById('preview');
  let activeTabElement = document.querySelector('.tab.active');

  addTabBtn.addEventListener('click', () => addTab());

  tabs.addEventListener('click', (event) => {
    const target = event.target.closest('.tab, .close-tab-btn');
    if (!target) return;

    if (target.classList.contains('tab')) {
      switchTab(target.dataset.tab);
    } else if (target.classList.contains('close-tab-btn')) {
      const tabId = target.parentElement.dataset.tab;
      closeTab(tabId);
    }
  });

  tabs.addEventListener('dblclick', (event) => {
    if (
      event.target.classList.contains('tab') ||
      event.target.parentElement.classList.contains('tab')
    ) {
      const tab = event.target.classList.contains('tab')
        ? event.target
        : event.target.parentElement;
      const tabId = tab.dataset.tab;
      const span = tab.querySelector('span');

      // タイトル編集用の入力フィールドを作成
      const input = document.createElement('input');
      input.type = 'text';
      input.value = span.textContent;
      tab.replaceChild(input, span);

      input.addEventListener('blur', () => {
        const newTitle = input.value || `Tab ${tabId}`;
        span.textContent = newTitle;
        tab.replaceChild(span, input);

        tabData[tabId].title = newTitle;
        saveTabData();
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          input.blur();
        }
      });

      input.focus();
    }
  });

  // closeTab関数を修正
  async function closeTab(tabId) {
    // タブIDを数値型に変換
    tabId = Number(tabId);

    // タブとエディタを削除
    const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
    const editor = document.querySelector(`.editor[data-tab="${tabId}"]`);

    if (tab) tab.remove();
    if (editor) editor.remove();

    // エディタとタブデータを削除
    if (editors[tabId]) {
      editors[tabId].dispose();
      delete editors[tabId];
    }
    delete tabData[tabId];
    delete markdownCache[tabId];

    // IndexedDBからデータを削除
    try {
      await Promise.all([
        deleteTabDataIndexedDB(tabId),
        deleteEditorContentIndexedDB(tabId),
      ]);
      await saveTabData(); // 残りのタブデータを保存
    } catch (error) {
      // eslint-disable-next-line no-undef
      console.error('Error deleting data from IndexedDB:', error);
    }

    initializedEditors.delete(tabId);

    // 残りのタブ処理
    const remainingTabs = Object.keys(tabData);
    if (remainingTabs.length > 0) {
      switchTab(Number(remainingTabs[0]));
    } else {
      currentTab = null;
      previewContainer.style.display = 'none';
      document.querySelectorAll('.editor').forEach((editor) => {
        editor.style.display = 'none';
      });
      addTab(); // タブが一つもない場合は新しいタブを作成
    }
  }

  previewContainer.style.display = 'none';

  document
    .getElementById('mode-switch-btn')
    .addEventListener('click', toggleMode);

  window.electron.receive('theme-changed', (isDark) => {
    if (monacoSettings) {
      monacoSettings.theme = isDark ? 'vs-dark' : 'vs-light';
      updateBodyTheme(isDark);
    }
  });

  window.electron.receive('monaco-settings', (settings) => {
    // 初回のみ実行されるようにする
    if (!monacoSettings) {
      monacoSettings = settings;
      updateBodyTheme(monacoSettings.theme === 'vs-dark');
      initializeTabs();
    }
  });

  window.addEventListener('resize', () => {
    if (currentTab && editors[currentTab]) {
      editors[currentTab].layout();
    }
  });

  previewContainer.addEventListener('click', (event) => {
    if (event.target.tagName === 'A') {
      event.preventDefault();
      window.electron.send('open-external', event.target.href);
    }
  });
});
