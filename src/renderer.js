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

  const icons = {
    plus: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
    trash: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`,
    pencil: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`,
    archive: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`,
    save: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`,
    copy: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
    eye: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
    file: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`,
    search: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    default: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
  };
  const tabData = {}; // Stores tab information
  let draggedTab = null;
  const markdownCache = {}; // Object to maintain markdown cache

  const initializedEditors = new Set(); // Track editor initialization state
  let tabHistory = []; // Stores tab history

  // IndexedDB Utilities
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

      // Clear existing data
      store.clear().onsuccess = () => {
        // Save current tab data
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

  // Function to delete tab data from IndexedDB
  function deleteTabDataIndexedDB(tabId) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['tabs'], 'readwrite');
      const store = transaction.objectStore('tabs');
      store.delete(Number(tabId));

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject('Delete tab data error');
    });
  }

  // Function to delete content from IndexedDB
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
    // Skip if already initialized or settings/tabId is invalid
    if (initializedEditors.has(tabId) || !settings || !tabId) return;

    const container = document.querySelector(`.editor[data-tab="${tabId}"]`);
    if (!container) {
      console.warn(`Editor container not found for tab ${tabId}`);
      return;
    }

    // Dispose and recreate if already exists
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

      editors[tabId].addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
        showCommandPalette();
      });

      initializedEditors.add(tabId);
    } catch (error) {
      console.error(`Failed to initialize editor for tab ${tabId}:`, error);
    }
  }

  // Get next available tab ID (sequential starting from 1)
  function getNextAvailableTabId() {
    const existingIds = Object.keys(tabData).map(Number).sort((a, b) => a - b);
    for (let i = 1; i <= existingIds.length + 1; i++) {
      if (!existingIds.includes(i)) {
        return i;
      }
    }
    return 1;
  }

  // Get display tab number (always sequential starting from 1)
  function getDisplayTabNumber(tabId) {
    // Calculate number based on current tab order
    const orderedTabs = getTabsByOrder();
    const index = orderedTabs.findIndex(tab => tab.id === Number(tabId));
    return index >= 0 ? index + 1 : orderedTabs.length + 1;
  }

  // Get tab position order
  function getTabsByOrder() {
    return Object.entries(tabData)
      .map(([id, data]) => ({ id: Number(id), ...data }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  // Update tab order
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

  // Scroll to active tab
  function scrollToActiveTab(tabElement) {
    if (!tabElement) return;

    const tabsContainer = document.getElementById('tabs');
    const tabRect = tabElement.getBoundingClientRect();
    const containerRect = tabsContainer.getBoundingClientRect();

    // If tab is outside left boundary
    if (tabRect.left < containerRect.left) {
      const scrollAmount = tabRect.left - containerRect.left - 10; // 10px margin
      tabsContainer.scrollLeft += scrollAmount;
    }
    // If tab is outside right boundary
    else if (tabRect.right > containerRect.right) {
      const scrollAmount = tabRect.right - containerRect.right + 10; // 10px margin
      tabsContainer.scrollLeft += scrollAmount;
    }
  }

  function updateBodyTheme(isDark) {
    document.body.classList.remove('dark-theme', 'light-theme');
    document.body.classList.add(isDark ? 'dark-theme' : 'light-theme');

    const markdownCssLink = document.getElementById('github-markdown-css');
    if (isDark) {
      markdownCssLink.href =
        'node_modules/github-markdown-css/github-markdown-dark.css';
    } else {
      markdownCssLink.href =
        'node_modules/github-markdown-css/github-markdown-light.css';
    }

    // Update editor theme
    const newTheme = isDark ? 'vs-dark' : 'vs-light';
    monaco.editor.setTheme(newTheme);

    // Update individual editor options
    Object.values(editors).forEach((editor) => {
      if (editor) {
        editor.updateOptions({ theme: newTheme });
      }
    });
  }

  function addTab(tabId = null, title = null, content = null) {
    // Ensure tabId is a number
    if (tabId !== null) {
      tabId = Number(tabId);
      if (isNaN(tabId)) tabId = getNextAvailableTabId();
    } else {
      tabId = getNextAvailableTabId();
    }

    // Create tabData object first then set title
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

    // Add title span
    const tabTitle = document.createElement('span');
    tabTitle.textContent = title;
    newTab.appendChild(tabTitle);

    // Add close button
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

    // Force initialize editor
    setTimeout(() => {
      initializeEditor(monacoSettings, tabId);
      const newTabElement = document.querySelector(`.tab[data-tab="${tabId}"]`);
      if (newTabElement) {
        scrollToActiveTab(newTabElement);
      }
    }, 0);
  }

  function switchTab(tabId) {
    // Convert tabId to number
    tabId = Number(tabId);
    if (isNaN(tabId)) return;

    // Update active tab class
    if (activeTabElement) {
      activeTabElement.classList.remove('active');
    }

    const newTab = document.querySelector(`.tab[data-tab="${tabId}"]`);
    if (newTab) {
      newTab.classList.add('active');
      activeTabElement = newTab;
      // Scroll so active tab is visible
      scrollToActiveTab(newTab);
    }

    // Hide previous tab
    if (currentTab) {
      const currentEditor = document.querySelector(
        `.editor[data-tab="${currentTab}"]`,
      );
      if (currentEditor) {
        currentEditor.style.display = 'none';
      }
    }

    currentTab = tabId;

    // Initialize editor (regardless of mode)
    initializeEditor(monacoSettings, tabId);

    // Show current tab based on mode
    if (isPreview) {
      const markdownContent = editors[currentTab]?.getValue() || '';
      const htmlContent = getMarkdownHtml(markdownContent, currentTab);
      if (previewContainer.innerHTML !== htmlContent) {
        previewContainer.innerHTML = htmlContent;
      }
      previewContainer.style.display = 'block';
      const editorEl = document.querySelector(`.editor[data-tab="${tabId}"]`);
      if (editorEl) editorEl.style.display = 'none';
    } else {
      previewContainer.style.display = 'none';
      const editorElement = document.querySelector(
        `.editor[data-tab="${tabId}"]`,
      );
      if (editorElement) {
        editorElement.style.display = 'block';
        if (editors[tabId]) {
          editors[tabId].layout();
        }
      }
    }

    // Update history: Clear existing ID and add to front
    tabHistory = [tabId, ...tabHistory.filter(id => id !== tabId)];
  }

  function getMarkdownHtml(content, tabId) {
    // Return from cache if valid
    if (markdownCache[tabId] && markdownCache[tabId].content === content) {
      return markdownCache[tabId].html;
    }
    // Parse and cache
    const html = marked.parse(content);
    markdownCache[tabId] = { content, html };
    return html;
  }

  function toggleMode() {
    isPreview = !isPreview;
    if (currentTab) {
      if (isPreview) {
        const markdownContent = editors[currentTab]?.getValue() || '';
        const htmlContent = getMarkdownHtml(markdownContent, currentTab);
        previewContainer.innerHTML = htmlContent;
        previewContainer.style.display = 'block';
        const editorEl = document.querySelector(`.editor[data-tab="${currentTab}"]`);
        if (editorEl) editorEl.style.display = 'none';
      } else {
        previewContainer.style.display = 'none';
        const editorElement = document.querySelector(`.editor[data-tab="${currentTab}"]`);
        if (editorElement) {
          editorElement.style.display = 'block';
          if (editors[currentTab]) {
            editors[currentTab].layout();
            editors[currentTab].focus();
          }
        }
      }
    }
  }

  async function initializeTabs() {
    await openDatabase();
    await loadTabDataIndexedDB();
    if (Object.keys(tabData).length > 0) {
      // Restore tabs in order
      const orderedTabs = getTabsByOrder();
      for (const tab of orderedTabs) {
        const content = await loadEditorContentIndexedDB(tab.id);
        addTab(tab.id, tab.title, content);
      }
    } else {
      addTab();
    }
  }

  function toggleTabBar() {
    document.body.classList.toggle('tabs-hidden');

    // Adjust layout for all editors
    Object.values(editors).forEach((editor) => {
      if (editor) editor.layout();
    });
  }

  async function saveTabData() {
    await saveTabDataIndexedDB();
  }

  const tabs = document.getElementById('tabs');
  const addTabBtn = document.querySelector('.add-tab-btn');
  const previewContainer = document.getElementById('preview');
  let activeTabElement = document.querySelector('.tab.active');

  addTabBtn.addEventListener('click', () => addTab());

  // Horizontal scroll for tab area
  tabs.addEventListener('wheel', (event) => {
    // Convert vertical scroll to horizontal
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      const scrollAmount = event.deltaY * 0.5; // Adjust scroll speed
      tabs.scrollLeft += scrollAmount;
    }
  }, { passive: false });

  // Global variable for context menu
  let contextMenu = null;

  // Create right-click context menu
  function createContextMenu(x, y, tabId) {
    // Remove existing menu if any
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

    // Dark theme support
    if (document.body.classList.contains('dark-theme')) {
      contextMenu.style.background = '#1f2937';
      contextMenu.style.borderColor = '#374151';
      contextMenu.style.color = '#f9fafb';
    }

    const menuItems = [
      {
        text: 'Copy to Clipboard',
        icon: '📋',
        action: () => copyToClipboard(tabId)
      },
      {
        text: 'Save as Markdown',
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

    // Keep within window boundaries
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      contextMenu.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      contextMenu.style.top = `${y - rect.height}px`;
    }
  }

  // Hide context menu
  function hideContextMenu() {
    if (contextMenu) {
      document.body.removeChild(contextMenu);
      contextMenu = null;
    }
  }

  // クリップボードにコピー機能
  async function copyToClipboard(tabId) {
    try {
      const content = editors[tabId]?.getValue() || '';
      await navigator.clipboard.writeText(content);
      showNotification('Copied to clipboard');
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      showNotification('Failed to copy', 'error');
    }
  }

  // Save current tab as Markdown function
  async function saveAsMarkdown(tabId) {
    try {
      const content = editors[tabId]?.getValue() || '';
      const tabTitle = tabData[tabId]?.title || `Tab ${tabId}`;
      const fileName = `${tabTitle}.md`;

      // Use Electron file save dialog
      window.electron.send('save-file', { content, fileName });
    } catch (error) {
      console.error('Failed to save file:', error);
      showNotification('Failed to save', 'error');
    }
  }

  // Show notification
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

    // Animation
    setTimeout(() => {
      notification.style.transform = 'translateX(0)';
    }, 10);

    // Remove after 3 seconds
    setTimeout(() => {
      notification.style.transform = 'translateX(100%)';
      setTimeout(() => {
        if (document.body.contains(notification)) {
          document.body.removeChild(notification);
        }
      }, 300);
    }, 3000);
  }

  // Context menu event
  tabs.addEventListener('contextmenu', (event) => {
    const tab = event.target.closest('.tab');
    if (tab && tab.dataset.tab) {
      event.preventDefault();
      createContextMenu(event.clientX, event.clientY, tab.dataset.tab);
    }
  });

  // Event to hide context menu
  document.addEventListener('click', (event) => {
    if (contextMenu && !contextMenu.contains(event.target)) {
      hideContextMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    // Ctrl/Cmd + K for Command Palette
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      event.preventDefault();
      showCommandPalette();
    }


    // Escapeキーでコンテキストメニューを閉じる
    if (event.key === 'Escape' && contextMenu) {
      hideContextMenu();
    }

    // Ctrl/Cmd + T で新しいタブを作成
    if ((event.ctrlKey || event.metaKey) && event.key === 't') {
      event.preventDefault();
      addTab();
    }

    // Escape key to close context menu
    if (event.key === 'Escape' && contextMenu) {
      hideContextMenu();
    }

    // Ctrl/Cmd + T for New Tab
    if ((event.ctrlKey || event.metaKey) && event.key === 't') {
      event.preventDefault();
      addTab();
    }

    // Ctrl/Cmd + W for Delete Tab
    if ((event.ctrlKey || event.metaKey) && event.key === 'w') {
      event.preventDefault();
      if (currentTab) {
        closeTab(currentTab);
      }
    }
  }, true);

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

  // Middle-click (wheel click) to delete tab
  tabs.addEventListener('mousedown', (event) => {
    // If middle-click
    if (event.button === 1) {
      event.preventDefault(); // Prevent default middle-click behavior

      const tab = event.target.closest('.tab');
      if (tab && tab.dataset.tab) {
        const tabId = tab.dataset.tab;
        closeTab(tabId);
      }
    }
  });

  // Drag & drop event listeners
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

  // Calculate position of element during dragging
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

  // Tab rename function
  function renameTab(tabId) {
    const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
    if (!tab) return;

    const span = tab.querySelector('span');
    if (!span) return;

    // Create input field for title editing
    const input = document.createElement('input');
    input.type = 'text';
    input.value = span.textContent;

    // Style adjustments
    input.style.width = '100px';
    input.style.background = 'transparent';
    input.style.border = 'none';
    input.style.outline = 'none';
    input.style.color = 'inherit';
    input.style.font = 'inherit';

    tab.replaceChild(input, span);

    input.addEventListener('blur', () => {
      const newTitle = input.value || `Tab ${getDisplayTabNumber(tabId)}`;
      span.textContent = newTitle;
      if (tab.contains(input)) {
        tab.replaceChild(span, input);
      }

      if (tabData[tabId]) {
        tabData[tabId].title = newTitle;
        saveTabData();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      }
    });

    // Select entire input field
    input.focus();
    input.select();
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

      renameTab(tabId);
    }
  });

  // Create custom confirmation dialog
  function showConfirmDialog(message) {
    return new Promise((resolve) => {
      // Create dialog container
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
      cancelBtn.textContent = 'Cancel';
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
      deleteBtn.textContent = 'Delete';
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

      // Keyboard navigation support
      const handleKeydown = (e) => {
        if (e.key === 'Escape') {
          handleCancel();
        } else if (e.key === 'Enter') {
          // Enter cancels only if cancel button is focused
          if (document.activeElement === cancelBtn) {
            handleCancel();
          } else {
            handleDelete();
          }
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          // Move focus between buttons with arrow keys
          if (document.activeElement === deleteBtn) {
            cancelBtn.focus();
          } else {
            deleteBtn.focus();
          }
        }
      };

      document.addEventListener('keydown', handleKeydown);

      // Cancel on clicking overlay
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

      // Focus cancel button by default
      setTimeout(() => {
        cancelBtn.focus();
      }, 10);

      // Add cleanup function
      const cleanup = () => {
        document.removeEventListener('keydown', handleKeydown);
      };

      // Cleanup on Promise resolution
      const originalResolve = resolve;
      resolve = (value) => {
        cleanup();
        originalResolve(value);
      };
    });
  }

  // Close tab function
  async function closeTab(tabId) {
    // Convert tabId to number
    tabId = Number(tabId);

    // Show confirmation dialog
    const tabTitle = tabData[tabId]?.title || `Tab ${tabId}`;
    const confirmMessage = `Are you sure you want to delete "${tabTitle}"?\n\nUnsaved changes will be lost.`;

    const confirmed = await showConfirmDialog(confirmMessage);
    if (!confirmed) {
      return; // Do nothing if cancelled
    }

    // Delete tab and editor
    const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
    const editor = document.querySelector(`.editor[data-tab="${tabId}"]`);

    if (tab) tab.remove();
    if (editor) editor.remove();

    // Dispose editor and delete data
    if (editors[tabId]) {
      editors[tabId].dispose();
      delete editors[tabId];
    }
    delete tabData[tabId];
    delete markdownCache[tabId];

    // Delete data from IndexedDB
    try {
      await Promise.all([
        deleteTabDataIndexedDB(tabId),
        deleteEditorContentIndexedDB(tabId),
      ]);
      await saveTabData(); // Save remaining tab data
    } catch (error) {
      console.error('Error deleting data from IndexedDB:', error);
    }

    initializedEditors.delete(tabId);

    // Remove from history
    tabHistory = tabHistory.filter(id => id !== tabId);

    // Process remaining tabs
    const remainingTabs = Object.keys(tabData);
    if (remainingTabs.length > 0) {
      switchTab(Number(remainingTabs[0]));
    } else {
      currentTab = null;
      previewContainer.style.display = 'none';
      document.querySelectorAll('.editor').forEach((editor) => {
        editor.style.display = 'none';
      });
      addTab(); // Create new tab if none left
    }
  }

  previewContainer.style.display = 'none';

  window.electron.receive('theme-changed', (isDark) => {
    if (monacoSettings) {
      monacoSettings.theme = isDark ? 'vs-dark' : 'vs-light';
      updateBodyTheme(isDark);
    }
  });

  window.electron.receive('monaco-settings', (settings) => {
    // Run only once
    if (!monacoSettings) {
      monacoSettings = settings;
      updateBodyTheme(monacoSettings.theme === 'vs-dark');
      initializeTabs();
    }
  });

  // Receive file save result
  window.electron.receive('save-file-success', (filePath) => {
    const fileName = filePath.split('/').pop().split('\\').pop(); // Cross-platform support
    showNotification(`File saved: ${fileName}`);
  });

  window.electron.receive('save-file-error', (error) => {
    showNotification(`Failed to save: ${error}`, 'error');
  });

  // --- Command Palette Implementation ---
  const paletteOverlay = document.getElementById('command-palette-overlay');
  const paletteInput = document.getElementById('command-palette-input');
  const paletteResults = document.getElementById('command-palette-results');
  let selectedResultIndex = 0;
  let currentResults = [];

  function showCommandPalette() {
    paletteOverlay.classList.remove('hidden');
    paletteInput.value = '';
    paletteInput.focus();
    updatePaletteResults();
  }

  let isRenaming = false;
  function hideCommandPalette() {
    paletteOverlay.classList.add('hidden');
    if (!isRenaming && currentTab && editors[currentTab]) {
      editors[currentTab].focus();
    }
  }

  async function updatePaletteResults() {
    const rawQuery = paletteInput.value.toLowerCase().trim();
    const keywords = rawQuery.split(/\s+/).filter(k => k.length > 0);
    const results = [];

    // Helper to check if text contains all keywords
    const isMatch = (text) => {
      if (keywords.length === 0) return true;
      const lowerText = text.toLowerCase();
      return keywords.every(k => lowerText.includes(k));
    };

    // 1. Static Commands
    const staticCommands = [
      { id: 'new-tab', type: 'command', label: 'New Tab', detail: 'Create a new markdown tab', icon: icons.plus, action: () => addTab() },
      {
        id: 'delete-tab', type: 'command', label: 'Delete Tab', detail: 'Close and delete the current tab', icon: icons.trash, action: () => {
          if (currentTab) {
            // Delay deletion slightly so the Enter key doesn't immediately confirm the dialog
            setTimeout(() => {
              closeTab(currentTab);
            }, 200);
          }
        }
      },
      {
        id: 'rename-tab', type: 'command', label: 'Rename Current Tab Name', detail: 'Rename the current tab', icon: icons.pencil, action: () => {
          if (currentTab) {
            // Signal that we are renaming so hideCommandPalette doesn't refocus the editor
            isRenaming = true;
            setTimeout(() => {
              renameTab(currentTab);
              isRenaming = false;
            }, 300); // Increased delay for more stability
          }
        }
      },
      { id: 'toggle-preview', type: 'command', label: 'Toggle Editor/Preview Mode', detail: 'Switch between markdown editor and preview', icon: icons.eye, action: () => toggleMode() },
      { id: 'toggle-tabs', type: 'command', label: 'Toggle Tab Bar Visibility', detail: 'Show or hide the tab bar', icon: icons.eye, action: () => toggleTabBar() },
      { id: 'export-current-md', type: 'command', label: 'Save Tab as Markdown', detail: 'Save current tab as a .md file', icon: icons.save, action: () => { if (currentTab) saveAsMarkdown(currentTab); } },
      { id: 'copy-clipboard', type: 'command', label: 'Copy Tab to Clipboard', detail: 'Copy current tab content to clipboard', icon: icons.copy, action: () => { if (currentTab) copyToClipboard(currentTab); } },
      { id: 'backup-export-all', type: 'command', label: 'Backup: Export All Tabs (.zip)', detail: 'Export all tabs as a ZIP file', icon: icons.archive, action: () => exportAllTabs() },
    ];

    staticCommands.forEach(cmd => {
      if (isMatch(cmd.label)) {
        results.push(cmd);
      }
    });

    // 2. Tab Names
    if (keywords.length === 0) {
      // Show Recently Opened (max 5, exclude current)
      const recentTabs = tabHistory.filter(id => id !== currentTab).slice(0, 5);
      recentTabs.forEach(id => {
        const data = tabData[id];
        if (data) {
          results.push({
            id: `tab-${id}`,
            type: 'tab',
            label: `Opened Recently: ${data.title}`,
            detail: `Switch focus to tab ${data.title}`,
            icon: icons.file,
            action: () => switchTab(Number(id))
          });
        }
      });
    } else {
      // Search all tabs
      Object.entries(tabData).forEach(([id, data]) => {
        if (isMatch(data.title)) {
          results.push({
            id: `tab-${id}`,
            type: 'tab',
            label: `Jump to Tab: ${data.title}`,
            detail: `Switch focus to tab ${data.title}`,
            icon: icons.file,
            action: () => switchTab(Number(id))
          });
        }
      });
    }

    // 3. Full Text Search (if query is not empty)
    if (keywords.length > 0 && !(keywords.length === 1 && keywords[0].length < 2)) {
      for (const [id, data] of Object.entries(tabData)) {
        const tabId = Number(id);
        let content = '';

        if (editors[tabId] && editors[tabId].getModel()) {
          content = editors[tabId].getValue();
        } else {
          content = await loadEditorContentIndexedDB(tabId);
        }

        if (content) {
          const lines = content.split('\n');
          lines.forEach((line, index) => {
            if (isMatch(line)) {
              results.push({
                id: `search-${tabId}-${index}`,
                type: 'search',
                label: data.title,
                detail: `Line ${index + 1}: ${line.trim()}`,
                icon: icons.search,
                action: () => {
                  switchTab(tabId);
                  setTimeout(() => {
                    const editor = editors[tabId];
                    if (editor) {
                      const lineNum = index + 1;
                      editor.revealLineInCenter(lineNum);
                      // Highlight the first keyword found
                      const firstKeyword = keywords[0];
                      editor.setPosition({ lineNumber: lineNum, column: line.toLowerCase().indexOf(firstKeyword) + 1 });
                      editor.focus();
                    }
                  }, 50);
                }
              });
            }
          });
        }
      }
    }

    currentResults = results.slice(0, 15); // Show up to 15 results
    renderPaletteResults();
  }

  function renderPaletteResults() {
    paletteResults.innerHTML = '';
    selectedResultIndex = Math.min(selectedResultIndex, currentResults.length - 1);
    if (selectedResultIndex < 0) selectedResultIndex = 0;

    currentResults.forEach((result, index) => {
      const div = document.createElement('div');
      div.className = `command-item ${index === selectedResultIndex ? 'selected' : ''}`;

      // Icon container
      const icon = document.createElement('div');
      icon.className = 'command-icon';
      icon.innerHTML = result.icon || icons.default;

      // Text container
      const content = document.createElement('div');
      content.className = 'command-content';

      const label = document.createElement('div');
      label.className = 'command-label';
      label.textContent = result.label;

      const detail = document.createElement('div');
      detail.className = 'command-detail';
      detail.textContent = result.detail;

      content.appendChild(label);
      content.appendChild(detail);

      div.appendChild(icon);
      div.appendChild(content);

      div.addEventListener('click', () => {
        result.action();
        hideCommandPalette();
      });

      paletteResults.appendChild(div);
    });
  }

  paletteInput.addEventListener('input', () => {
    selectedResultIndex = 0;
    updatePaletteResults();
  });

  paletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedResultIndex = (selectedResultIndex + 1) % currentResults.length;
      renderPaletteResults();
      const selectedItem = paletteResults.children[selectedResultIndex];
      if (selectedItem) selectedItem.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedResultIndex = (selectedResultIndex - 1 + currentResults.length) % currentResults.length;
      renderPaletteResults();
      const selectedItem = paletteResults.children[selectedResultIndex];
      if (selectedItem) selectedItem.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentResults[selectedResultIndex]) {
        currentResults[selectedResultIndex].action();
        hideCommandPalette();
      }
    } else if (e.key === 'Escape') {
      hideCommandPalette();
    }
  });

  paletteOverlay.addEventListener('click', (e) => {
    if (e.target === paletteOverlay) {
      hideCommandPalette();
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

  // Export all tabs handler
  async function exportAllTabs() {
    const tabsToExport = [];
    const orderedTabs = getTabsByOrder();

    for (const tab of orderedTabs) {
      let content = '';
      // If editor is initialized and valid, get value from it
      if (editors[tab.id] && editors[tab.id].getModel()) {
        content = editors[tab.id].getValue();
      } else {
        // Otherwise load from DB
        try {
          content = await loadEditorContentIndexedDB(tab.id);
        } catch (e) {
          console.error(`Failed to load content for tab ${tab.id}`, e);
          content = '';
        }
      }

      let filename = (tab.title || `Tab ${tab.id}`).trim();
      // Replace spaces with _
      filename = filename.replace(/\s+/g, '_');
      // Sanitize filename (remove invalid chars for Windows/Mac/Linux)
      // Invalid: \ / : * ? " < > |
      filename = filename.replace(/[\\/:*?"<>|]/g, '');

      if (!filename) filename = `Tab_${tab.id}`;

      let finalFilename = filename + '.md';
      let counter = 1;

      // Ensure uniqueness
      while (tabsToExport.some(t => t.filename === finalFilename)) {
        finalFilename = `${filename}_${counter}.md`;
        counter++;
      }

      tabsToExport.push({
        filename: finalFilename,
        content: content || ''
      });
    }

    window.electron.sendExportData(tabsToExport);
  }





  window.electron.onExportRequest(() => {
    exportAllTabs();
  });
});
