// Scratch-tab persistence for one window. The legacy SainteDevoteDB is left
// in place so an older build can still open the pre-upgrade tabs.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.workspaceStore = api;
})(globalThis, function () {
  const DB_NAME = 'SainteDevoteWorkspaces';
  const LEGACY_DB_NAME = 'SainteDevoteDB';
  const DB_VERSION = 1;

  function workspaceRange(workspaceId) {
    return IDBKeyRange.bound([workspaceId], [workspaceId, []]);
  }

  function createWorkspaceId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    });
  }

  function deleteDatabase(name) {
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }

  function openWorkspaceDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('workspaces')) {
          database.createObjectStore('workspaces', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('tabs')) {
          database.createObjectStore('tabs', { keyPath: ['workspaceId', 'id'] });
        }
        if (!database.objectStoreNames.contains('content')) {
          database.createObjectStore('content', { keyPath: ['workspaceId', 'tabId'] });
        }
        if (!database.objectStoreNames.contains('meta')) {
          database.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    });
  }

  function readLegacy() {
    return new Promise((resolve, reject) => {
      let created = false;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onupgradeneeded = (event) => {
        if (event.oldVersion === 0) {
          created = true;
          request.transaction.abort();
        }
      };
      request.onerror = () => {
        if (created) {
          deleteDatabase(LEGACY_DB_NAME).then(() => finish(null));
          return;
        }
        fail(request.error);
      };
      request.onsuccess = () => {
        const database = request.result;
        if (created || !database.objectStoreNames.contains('tabs')) {
          database.close();
          if (created) {
            deleteDatabase(LEGACY_DB_NAME).then(() => finish(null));
          } else {
            finish(null);
          }
          return;
        }
        const storeNames = ['tabs'];
        if (database.objectStoreNames.contains('content')) {
          storeNames.push('content');
        }
        const transaction = database.transaction(storeNames, 'readonly');
        const tabsRequest = transaction.objectStore('tabs').getAll();
        const contentRequest = storeNames.includes('content')
          ? transaction.objectStore('content').getAll()
          : null;
        transaction.oncomplete = () => {
          database.close();
          const contentByTabId = {};
          (contentRequest ? contentRequest.result : []).forEach((row) => {
            contentByTabId[row.tabId] = row.content;
          });
          finish({
            tabs: tabsRequest.result || [],
            contentByTabId,
          });
        };
        transaction.onerror = () => {
          database.close();
          fail(transaction.error);
        };
      };
    });
  }

  function migrateLegacy(db, workspaceId) {
    return readLegacy().then((legacy) => new Promise((resolve, reject) => {
      const transaction = db.transaction(['tabs', 'content', 'meta'], 'readwrite');
      const meta = transaction.objectStore('meta');
      const existing = meta.get('legacyMigration');
      let migrated = false;
      existing.onsuccess = () => {
        if (existing.result && existing.result.done) return;
        if (legacy) {
          const tabs = transaction.objectStore('tabs');
          const content = transaction.objectStore('content');
          legacy.tabs.forEach((tab, index) => {
            const id = Number(tab.id) || index + 1;
            tabs.put({
              workspaceId,
              id,
              title: tab.title || '',
              order: tab.order || 0,
            });
            const stored = legacy.contentByTabId[id];
            const text = stored !== undefined ? stored : (tab.content || '');
            content.put({ workspaceId, tabId: id, content: text });
          });
          migrated = legacy.tabs.length > 0;
        }
        meta.put({ key: 'legacyMigration', done: true, at: Date.now() });
      };
      transaction.oncomplete = () => resolve(migrated);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    }));
  }

  function listWorkspaces(db) {
    const transaction = db.transaction(['workspaces'], 'readonly');
    const request = transaction.objectStore('workspaces').getAll();
    return requestResult(request);
  }

  function ensureWorkspace(db, workspaceId) {
    const transaction = db.transaction(['workspaces'], 'readwrite');
    const store = transaction.objectStore('workspaces');
    const existing = store.get(workspaceId);
    existing.onsuccess = () => {
      if (!existing.result) {
        const now = Date.now();
        store.put({ id: workspaceId, createdAt: now, lastActiveAt: now });
      }
    };
    return transactionDone(transaction);
  }

  function touchWorkspace(store, workspaceId) {
    const existing = store.get(workspaceId);
    existing.onsuccess = () => {
      const now = Date.now();
      store.put({
        id: workspaceId,
        createdAt: existing.result ? existing.result.createdAt : now,
        lastActiveAt: now,
      });
    };
  }

  function saveScratchMeta(db, workspaceId, tabs) {
    const transaction = db.transaction(['tabs', 'workspaces'], 'readwrite');
    const store = transaction.objectStore('tabs');
    store.delete(workspaceRange(workspaceId));
    tabs.forEach((tab) => {
      const row = {
        workspaceId,
        id: Number(tab.id),
        title: tab.title,
        order: tab.order || 0,
      };
      if (tab.origin && tab.origin.workspace) {
        // Handoff record: used by absorbWorkspace to skip a tab that already
        // reached another window (the source copy was orphaned by a crash).
        row.origin = {
          workspace: String(tab.origin.workspace),
          tab: Number(tab.origin.tab),
        };
      }
      store.put(row);
    });
    touchWorkspace(transaction.objectStore('workspaces'), workspaceId);
    return transactionDone(transaction);
  }

  async function loadTabs(db, workspaceId) {
    const transaction = db.transaction(['tabs', 'content'], 'readonly');
    const range = workspaceRange(workspaceId);
    const tabsRequest = transaction.objectStore('tabs').getAll(range);
    const contentRequest = transaction.objectStore('content').getAll(range);
    await transactionDone(transaction);
    const contentById = new Map();
    (contentRequest.result || []).forEach((row) => {
      contentById.set(row.tabId, row.content || '');
    });
    return (tabsRequest.result || [])
      .map((tab) => ({
        id: tab.id,
        title: tab.title,
        order: tab.order || 0,
        origin: tab.origin || null,
        content: contentById.get(tab.id) || '',
      }))
      .sort((left, right) => left.order - right.order || left.id - right.id);
  }

  function saveContent(db, workspaceId, tabId, content) {
    const transaction = db.transaction(['content', 'workspaces'], 'readwrite');
    transaction.objectStore('content').put({
      workspaceId,
      tabId: Number(tabId),
      content,
    });
    touchWorkspace(transaction.objectStore('workspaces'), workspaceId);
    return transactionDone(transaction);
  }

  function loadContent(db, workspaceId, tabId) {
    const transaction = db.transaction(['content'], 'readonly');
    const request = transaction.objectStore('content').get([workspaceId, Number(tabId)]);
    return requestResult(request).then((row) => (row ? row.content : ''));
  }

  function deleteTab(db, workspaceId, tabId) {
    const key = [workspaceId, Number(tabId)];
    const transaction = db.transaction(['tabs', 'content'], 'readwrite');
    transaction.objectStore('tabs').delete(key);
    transaction.objectStore('content').delete(key);
    return transactionDone(transaction);
  }

  function deleteWorkspace(db, workspaceId) {
    const transaction = db.transaction(['tabs', 'content', 'workspaces'], 'readwrite');
    const range = workspaceRange(workspaceId);
    transaction.objectStore('tabs').delete(range);
    transaction.objectStore('content').delete(range);
    transaction.objectStore('workspaces').delete(workspaceId);
    return transactionDone(transaction);
  }

  async function absorbWorkspace(db, targetId, sourceId) {
    if (targetId === sourceId) return;
    const sourceTabs = await loadTabs(db, sourceId);
    const targetTabs = await loadTabs(db, targetId);
    const used = new Set(targetTabs.map((tab) => tab.id));
    // A tab handed over to another window is removed from the source
    // workspace by that window's renderer, asynchronously. If the app died in
    // between, the source still lists it, and absorbing would resurrect it as
    // a duplicate next to the copy the target window already holds. Identify
    // adopted tabs by handoff origin (source workspace + tab id), never by
    // content: two legitimately identical tabs must both survive.
    const adoptedFrom = new Set();
    targetTabs.forEach((tab) => {
      if (tab.origin && tab.origin.workspace) {
        adoptedFrom.add(`${tab.origin.workspace}\u0000${tab.origin.tab}`);
      }
    });
    const moved = [];
    sourceTabs.forEach((tab) => {
      if (!tab.content || tab.content.trim().length === 0) return;
      if (adoptedFrom.has(`${sourceId}\u0000${tab.id}`)) return;
      let id = 1;
      while (used.has(id)) id += 1;
      used.add(id);
      moved.push({
        id,
        title: tab.title,
        order: targetTabs.length + moved.length,
        content: tab.content,
      });
    });
    const transaction = db.transaction(['tabs', 'content', 'workspaces'], 'readwrite');
    const tabs = transaction.objectStore('tabs');
    const content = transaction.objectStore('content');
    moved.forEach((tab) => {
      tabs.put({
        workspaceId: targetId,
        id: tab.id,
        title: tab.title,
        order: tab.order,
      });
      content.put({
        workspaceId: targetId,
        tabId: tab.id,
        content: tab.content,
      });
    });
    const range = workspaceRange(sourceId);
    tabs.delete(range);
    content.delete(range);
    transaction.objectStore('workspaces').delete(sourceId);
    await transactionDone(transaction);
  }

  async function claimId(claim, workspaceId) {
    const granted = await claim([workspaceId]);
    return Array.isArray(granted) && granted.includes(workspaceId);
  }

  // Globally-unique Untitled numbering across all windows. The meta store is
  // shared per-origin, and IndexedDB serializes readwrite transactions on the
  // same store, so a read-increment-write inside one transaction is atomic
  // even when several windows ask at the same time.
  function nextUntitledNumber(db) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['meta'], 'readwrite');
      const store = transaction.objectStore('meta');
      const request = store.get('untitledCounter');
      let next = 1;
      request.onsuccess = () => {
        const current = request.result ? Number(request.result.value) || 0 : 0;
        next = current + 1;
        store.put({ key: 'untitledCounter', value: next });
      };
      transaction.oncomplete = () => resolve(next);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    });
  }

  // Seed the global counter from any "Untitled N" tabs that already exist
  // (e.g. restored scratch tabs or legacy migrations) so newly created tabs
  // never reuse a number that is already taken.
  function seedUntitledCounter(db, tabs) {
    let max = 0;
    tabs.forEach((tab) => {
      const match = /^Untitled (\d+)$/.exec(tab.title || '');
      if (match) max = Math.max(max, Number(match[1]));
    });
    if (max === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['meta'], 'readwrite');
      const store = transaction.objectStore('meta');
      const request = store.get('untitledCounter');
      request.onsuccess = () => {
        const current = request.result ? Number(request.result.value) || 0 : 0;
        if (max > current) {
          store.put({ key: 'untitledCounter', value: max });
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    });
  }

  async function bootstrap({ role, workspaceId, claim }) {
    const db = await openWorkspaceDb();
    let ownId = workspaceId || null;
    if (role === 'primary') {
      const existing = await listWorkspaces(db);
      existing.sort((left, right) => (right.lastActiveAt || 0) - (left.lastActiveAt || 0));
      if (!ownId) {
        const preferred = existing[0] ? existing[0].id : createWorkspaceId();
        if (await claimId(claim, preferred)) {
          ownId = preferred;
        } else {
          ownId = createWorkspaceId();
          if (!(await claimId(claim, ownId))) {
            throw new Error('failed to claim workspace');
          }
        }
      }
      await ensureWorkspace(db, ownId);
      await migrateLegacy(db, ownId);
      const rest = existing.map((workspace) => workspace.id).filter((id) => id !== ownId);
      const absorbed = rest.length ? await claim(rest) : [];
      for (const id of absorbed) {
        await absorbWorkspace(db, ownId, id);
      }
    } else if (!ownId) {
      ownId = createWorkspaceId();
      if (!(await claimId(claim, ownId))) {
        ownId = createWorkspaceId();
        if (!(await claimId(claim, ownId))) {
          throw new Error('failed to claim workspace');
        }
      }
      await ensureWorkspace(db, ownId);
    } else {
      await ensureWorkspace(db, ownId);
    }
    const tabs = await loadTabs(db, ownId);
    await seedUntitledCounter(db, tabs);
    return { db, workspaceId: ownId, tabs };
  }

  return {
    DB_NAME,
    LEGACY_DB_NAME,
    createWorkspaceId,
    openWorkspaceDb,
    migrateLegacy,
    listWorkspaces,
    saveScratchMeta,
    loadTabs,
    saveContent,
    loadContent,
    deleteTab,
    deleteWorkspace,
    absorbWorkspace,
    bootstrap,
    nextUntitledNumber,
    seedUntitledCounter,
    deleteDatabase,
  };
});
