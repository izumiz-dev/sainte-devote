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
  let isPreview = false;
  let monacoSettings;
  const tabData = {}; // タブ情報を保持
  let draggedTab = null;
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
            order: tab.order || 0,
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
            order: tab.order || 0,
          };
        });
        // tabCountは使用しないため削除
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
    // 既に初期化済みまたは設定が不正な場合はスキップ
    if (initializedEditors.has(tabId) || !settings || !tabId) return;

    const container = document.querySelector(`.editor[data-tab="${tabId}"]`);
    if (!container) {
      console.warn(`Editor container not found for tab ${tabId}`);
      return;
    }

    // 既存のエディタがある場合は破棄してから再作成
    if (editors[tabId]) {
      editors[tabId].dispose();
      delete editors[tabId];
    }

    try {
      editors[tabId] = monaco.editor.create(container, {
        ...settings,
        scrollbar: {
          vertical: 'hidden',
          horizontal: 'hidden',
        },
      });

      loadEditorContentIndexedDB(tabId).then((savedContent) => {
        if (savedContent && editors[tabId]) {
          editors[tabId].setValue(savedContent);
        }
      });

      editors[tabId].onDidChangeModelContent(async () => {
        if (editors[tabId]) {
          const content = editors[tabId].getValue();
          await saveEditorContentIndexedDB(tabId, content);
        }
      });

      initializedEditors.add(tabId);
    } catch (error) {
      console.error(`Failed to initialize editor for tab ${tabId}:`, error);
    }
  }

  // 利用可能な次のタブIDを取得（1から始まる連番）
  function getNextAvailableTabId() {
    const existingIds = Object.keys(tabData).map(Number).sort((a, b) => a - b);
    for (let i = 1; i <= existingIds.length + 1; i++) {
      if (!existingIds.includes(i)) {
        return i;
      }
    }
    return 1;
  }

  // 表示用のタブ番号を取得（常に1から始まる連番）
  function getDisplayTabNumber(tabId) {
    // 現在のタブの順序に基づいて番号を計算
    const orderedTabs = getTabsByOrder();
    const index = orderedTabs.findIndex(tab => tab.id === Number(tabId));
    return index >= 0 ? index + 1 : orderedTabs.length + 1;
  }

  // タブの位置順序を取得
  function getTabsByOrder() {
    return Object.entries(tabData)
      .map(([id, data]) => ({ id: Number(id), ...data }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  // タブの順序を更新
  function updateTabOrder() {
    const tabs = document.querySelectorAll('.tab[data-tab]:not(.add-tab-btn)');
    tabs.forEach((tab, index) => {
      const tabId = Number(tab.dataset.tab);
      if (tabData[tabId]) {
        tabData[tabId].order = index;
      }
    });
    saveTabData();
  }

  // アクティブタブにスクロール
  function scrollToActiveTab(tabElement) {
    if (!tabElement) return;
    
    const tabsContainer = document.getElementById('tabs');
    const tabRect = tabElement.getBoundingClientRect();
    const containerRect = tabsContainer.getBoundingClientRect();
    
    // タブがコンテナの左端より外側にある場合
    if (tabRect.left < containerRect.left) {
      const scrollAmount = tabRect.left - containerRect.left - 10; // 10pxのマージン
      tabsContainer.scrollLeft += scrollAmount;
    }
    // タブがコンテナの右端より外側にある場合
    else if (tabRect.right > containerRect.right) {
      const scrollAmount = tabRect.right - containerRect.right + 10; // 10pxのマージン
      tabsContainer.scrollLeft += scrollAmount;
    }
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
    if (tabId !== null) {
      tabId = Number(tabId);
      if (isNaN(tabId)) tabId = getNextAvailableTabId();
    } else {
      tabId = getNextAvailableTabId();
    }

    // tabDataオブジェクトを先に作成してからタイトルを設定
    const currentOrder = Object.keys(tabData).length;
    tabData[tabId] = {
      id: tabId,
      title: '',
      content: content || '',
      order: currentOrder,
    };

    title = title || `Tab ${getDisplayTabNumber(tabId)}`;
    tabData[tabId].title = title;

    const tabs = document.getElementById('tabs');
    const newTab = document.createElement('button');
    newTab.classList.add('tab');
    newTab.dataset.tab = tabId;
    newTab.draggable = true;

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
    saveTabData();

    switchTab(tabId);
    
    // エディタを強制初期化（プレビューモードに関係なく）
    setTimeout(() => {
      initializeEditor(monacoSettings, tabId);
      const newTabElement = document.querySelector(`.tab[data-tab="${tabId}"]`);
      if (newTabElement) {
        scrollToActiveTab(newTabElement);
      }
    }, 0);
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

    // アクティブタブが表示されるようにスクロール
    scrollToActiveTab(newTab);

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

    // エディタを初期化（モードに関係なく）
    initializeEditor(monacoSettings, tabId);

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

      // エディタのレイアウト調整
      if (editors[tabId]) {
        editors[tabId].layout();
      }
    }
  }

  async function initializeTabs() {
    await openDatabase();
    await loadTabDataIndexedDB();
    if (Object.keys(tabData).length > 0) {
      // 順序通りにタブを復元
      const orderedTabs = getTabsByOrder();
      for (const tab of orderedTabs) {
        const content = await loadEditorContentIndexedDB(tab.id);
        addTab(tab.id, tab.title, content);
      }
    } else {
      addTab();
    }
  }

  function toggleMode() {
    isPreview = !isPreview;
    if (isPreview) {
      const markdownContent = editors[currentTab]?.getValue() || '';
      const htmlContent = marked.parse(markdownContent);
      previewContainer.innerHTML = htmlContent;
      document.querySelector(
        `.editor[data-tab="${currentTab}"]`,
      ).style.display = 'none';
      previewContainer.style.display = 'block';
    } else {
      previewContainer.style.display = 'none';
      const editorElement = document.querySelector(
        `.editor[data-tab="${currentTab}"]`,
      );
      editorElement.style.display = 'block';

      // プレビューモード解除時に未初期化エディタをチェック・初期化
      if (!editors[currentTab] && monacoSettings) {
        initializeEditor(monacoSettings, currentTab);
      }
      
      // エディタのレイアウト調整
      if (editors[currentTab]) {
        editors[currentTab].layout();
      }
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

  // タブエリアでの水平スクロール機能
  tabs.addEventListener('wheel', (event) => {
    // 縦スクロールを水平スクロールに変換
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      const scrollAmount = event.deltaY * 0.5; // スクロール速度を調整
      tabs.scrollLeft += scrollAmount;
    }
  }, { passive: false });

  // 右クリックメニューのグローバル変数
  let contextMenu = null;
  let contextMenuTabId = null;

  // 右クリックメニューを作成
  function createContextMenu(x, y, tabId) {
    // 既存のメニューがあれば削除
    if (contextMenu) {
      document.body.removeChild(contextMenu);
    }

    contextMenu = document.createElement('div');
    contextMenu.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      background: white;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 10000;
      min-width: 180px;
      padding: 4px 0;
      font-size: 13px;
    `;

    // ダークテーマ対応
    if (document.body.classList.contains('dark-theme')) {
      contextMenu.style.background = '#1f2937';
      contextMenu.style.borderColor = '#374151';
      contextMenu.style.color = '#f9fafb';
    }

    const menuItems = [
      {
        text: 'クリップボードにコピー',
        icon: '📋',
        action: () => copyToClipboard(tabId)
      },
      {
        text: 'Markdownとして保存',
        icon: '💾',
        action: () => saveAsMarkdown(tabId)
      }
    ];

    menuItems.forEach(item => {
      const menuItem = document.createElement('div');
      menuItem.style.cssText = `
        padding: 8px 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: background-color 0.15s ease;
      `;

      menuItem.innerHTML = `<span>${item.icon}</span><span>${item.text}</span>`;

      menuItem.addEventListener('mouseenter', () => {
        menuItem.style.backgroundColor = document.body.classList.contains('dark-theme') 
          ? '#374151' : '#f3f4f6';
      });

      menuItem.addEventListener('mouseleave', () => {
        menuItem.style.backgroundColor = 'transparent';
      });

      menuItem.addEventListener('click', () => {
        item.action();
        hideContextMenu();
      });

      contextMenu.appendChild(menuItem);
    });

    document.body.appendChild(contextMenu);
    contextMenuTabId = tabId;

    // ウィンドウの境界内に収める
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      contextMenu.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      contextMenu.style.top = `${y - rect.height}px`;
    }
  }

  // 右クリックメニューを非表示
  function hideContextMenu() {
    if (contextMenu) {
      document.body.removeChild(contextMenu);
      contextMenu = null;
      contextMenuTabId = null;
    }
  }

  // クリップボードにコピー機能
  async function copyToClipboard(tabId) {
    try {
      const content = editors[tabId]?.getValue() || '';
      await navigator.clipboard.writeText(content);
      showNotification('クリップボードにコピーしました');
    } catch (error) {
      console.error('クリップボードへのコピーに失敗:', error);
      showNotification('コピーに失敗しました', 'error');
    }
  }

  // Markdownとして保存機能
  async function saveAsMarkdown(tabId) {
    try {
      const content = editors[tabId]?.getValue() || '';
      const tabTitle = tabData[tabId]?.title || `Tab ${tabId}`;
      const fileName = `${tabTitle}.md`;
      
      // Electronのファイル保存ダイアログを使用
      window.electron.send('save-file', { content, fileName });
    } catch (error) {
      console.error('ファイル保存に失敗:', error);
      showNotification('保存に失敗しました', 'error');
    }
  }

  // 通知を表示
  function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 50px;
      right: 20px;
      background: ${type === 'error' ? '#dc2626' : '#059669'};
      color: white;
      padding: 12px 20px;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 10001;
      font-size: 14px;
      transition: all 0.3s ease;
      transform: translateX(100%);
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    // アニメーション
    setTimeout(() => {
      notification.style.transform = 'translateX(0)';
    }, 10);

    // 3秒後に削除
    setTimeout(() => {
      notification.style.transform = 'translateX(100%)';
      setTimeout(() => {
        if (document.body.contains(notification)) {
          document.body.removeChild(notification);
        }
      }, 300);
    }, 3000);
  }

  // 右クリックイベント
  tabs.addEventListener('contextmenu', (event) => {
    const tab = event.target.closest('.tab');
    if (tab && tab.dataset.tab) {
      event.preventDefault();
      createContextMenu(event.clientX, event.clientY, tab.dataset.tab);
    }
  });

  // メニューを非表示にするイベント
  document.addEventListener('click', (event) => {
    if (contextMenu && !contextMenu.contains(event.target)) {
      hideContextMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && contextMenu) {
      hideContextMenu();
    }
  });

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

  // ホイールクリック（中クリック）でタブを削除
  tabs.addEventListener('mousedown', (event) => {
    // 中クリック（ホイールクリック）の場合
    if (event.button === 1) {
      event.preventDefault(); // デフォルトの中クリック動作を防ぐ
      
      const tab = event.target.closest('.tab');
      if (tab && tab.dataset.tab) {
        const tabId = tab.dataset.tab;
        closeTab(tabId);
      }
    }
  });

  // ドラッグ&ドロップイベントリスナー
  tabs.addEventListener('dragstart', (event) => {
    if (event.target.classList.contains('tab') && event.target.dataset.tab) {
      draggedTab = event.target;
      event.target.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    }
  });

  tabs.addEventListener('dragend', (event) => {
    if (event.target.classList.contains('tab')) {
      event.target.classList.remove('dragging');
      draggedTab = null;
      updateTabOrder();
    }
  });

  tabs.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    
    const afterElement = getDragAfterElement(tabs, event.clientX);
    if (draggedTab && afterElement == null) {
      tabs.insertBefore(draggedTab, addTabBtn);
    } else if (draggedTab && afterElement) {
      tabs.insertBefore(draggedTab, afterElement);
    }
  });

  // ドラッグ中の要素の位置を計算
  function getDragAfterElement(container, x) {
    const draggableElements = [...container.querySelectorAll('.tab:not(.dragging):not(.add-tab-btn)')];
    
    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;
      
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

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
        const newTitle = input.value || `Tab ${getDisplayTabNumber(tabId)}`;
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

  // カスタム確認ダイアログを作成
  function showConfirmDialog(message) {
    return new Promise((resolve) => {
      // ダイアログコンテナを作成
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        backdrop-filter: blur(2px);
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: white;
        border-radius: 12px;
        padding: 24px;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
        max-width: 400px;
        width: 90%;
        text-align: center;
      `;

      // ダークテーマ対応
      if (document.body.classList.contains('dark-theme')) {
        dialog.style.background = '#1f2937';
        dialog.style.color = '#f9fafb';
      }

      const messageEl = document.createElement('p');
      messageEl.textContent = message;
      messageEl.style.cssText = `
        margin: 0 0 24px 0;
        line-height: 1.5;
        font-size: 14px;
      `;

      const buttonContainer = document.createElement('div');
      buttonContainer.style.cssText = `
        display: flex;
        gap: 12px;
        justify-content: center;
      `;

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.style.cssText = `
        padding: 8px 20px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        background: #f9fafb;
        color: #374151;
        font-size: 14px;
        cursor: pointer;
        font-weight: 500;
      `;

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '削除';
      deleteBtn.style.cssText = `
        padding: 8px 20px;
        border: 1px solid #dc2626;
        border-radius: 6px;
        background: #dc2626;
        color: white;
        font-size: 14px;
        cursor: pointer;
        font-weight: 500;
      `;

      // ダークテーマでのボタンスタイル調整
      if (document.body.classList.contains('dark-theme')) {
        cancelBtn.style.background = '#374151';
        cancelBtn.style.borderColor = '#4b5563';
        cancelBtn.style.color = '#d1d5db';
      }

      // イベントリスナー
      const handleCancel = () => {
        document.body.removeChild(overlay);
        resolve(false);
      };

      const handleDelete = () => {
        document.body.removeChild(overlay);
        resolve(true);
      };

      cancelBtn.addEventListener('click', handleCancel);
      deleteBtn.addEventListener('click', handleDelete);

      // Escapeキーでキャンセル
      const handleKeydown = (e) => {
        if (e.key === 'Escape') {
          handleCancel();
        } else if (e.key === 'Enter') {
          // Enterキーはキャンセルボタンがフォーカスされている場合のみキャンセル
          if (document.activeElement === cancelBtn) {
            handleCancel();
          } else {
            handleDelete();
          }
        }
      };

      document.addEventListener('keydown', handleKeydown);

      // オーバーレイクリックでキャンセル
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          handleCancel();
        }
      });

      buttonContainer.appendChild(deleteBtn);
      buttonContainer.appendChild(cancelBtn);
      dialog.appendChild(messageEl);
      dialog.appendChild(buttonContainer);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      // キャンセルボタンにフォーカス（デフォルト選択）
      setTimeout(() => {
        cancelBtn.focus();
      }, 10);

      // クリーンアップ関数を追加
      const cleanup = () => {
        document.removeEventListener('keydown', handleKeydown);
      };

      // Promise解決時にクリーンアップ
      const originalResolve = resolve;
      resolve = (value) => {
        cleanup();
        originalResolve(value);
      };
    });
  }

  // closeTab関数を修正
  async function closeTab(tabId) {
    // タブIDを数値型に変換
    tabId = Number(tabId);

    // 確認ダイアログを表示
    const tabTitle = tabData[tabId]?.title || `Tab ${tabId}`;
    const confirmMessage = `「${tabTitle}」を削除しますか？\n\n保存されていない変更は失われます。`;
    
    const confirmed = await showConfirmDialog(confirmMessage);
    if (!confirmed) {
      return; // キャンセルされた場合は何もしない
    }

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

  // ファイル保存結果の受信
  window.electron.receive('save-file-success', (filePath) => {
    const fileName = filePath.split('/').pop().split('\\').pop(); // クロスプラットフォーム対応
    showNotification(`ファイルを保存しました: ${fileName}`);
  });

  window.electron.receive('save-file-error', (error) => {
    showNotification(`保存に失敗しました: ${error}`, 'error');
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
