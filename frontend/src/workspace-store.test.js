require('fake-indexeddb/auto');

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('./workspace-store.js');

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resetDatabases() {
  await store.deleteDatabase(store.DB_NAME);
  await store.deleteDatabase(store.LEGACY_DB_NAME);
  await delay(0);
}

function seedLegacy(tabs) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(store.LEGACY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('tabs', { keyPath: 'id' });
      database.createObjectStore('content', { keyPath: 'tabId' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['tabs', 'content'], 'readwrite');
      tabs.forEach((tab) => {
        transaction.objectStore('tabs').put({
          id: tab.id,
          title: tab.title,
          content: tab.inlineContent || '',
          order: tab.order || 0,
        });
        if (tab.storedContent !== undefined) {
          transaction.objectStore('content').put({
            tabId: tab.id,
            content: tab.storedContent,
          });
        }
      });
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

beforeEach(async () => {
  await resetDatabases();
});

test('migration prefers the content store and does not run twice', async () => {
  await seedLegacy([
    {
      id: 1,
      title: 'Notes',
      inlineContent: 'from tab record',
      storedContent: 'from content store',
      order: 0,
    },
  ]);
  const db = await store.openWorkspaceDb();
  const workspaceId = store.createWorkspaceId();
  assert.equal(await store.migrateLegacy(db, workspaceId), true);
  const tabs = await store.loadTabs(db, workspaceId);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].content, 'from content store');
  assert.equal(await store.migrateLegacy(db, workspaceId), false);
  assert.equal((await store.loadTabs(db, workspaceId)).length, 1);
  db.close();
});

test('a missing legacy database is not left behind', async () => {
  const claims = new Set();
  const boot = await store.bootstrap({
    role: 'primary',
    workspaceId: null,
    claim: async (ids) => {
      const granted = [];
      ids.forEach((id) => {
        if (!claims.has(id)) {
          claims.add(id);
          granted.push(id);
        }
      });
      return granted;
    },
  });
  assert.equal(boot.tabs.length, 0);
  boot.db.close();
  const names = (await indexedDB.databases()).map((entry) => entry.name);
  assert.equal(names.includes(store.LEGACY_DB_NAME), false);
});

test('saving one workspace does not erase another', async () => {
  const db = await store.openWorkspaceDb();
  const first = 'a'.repeat(32);
  const second = 'b'.repeat(32);
  await store.saveScratchMeta(db, first, [{ id: 1, title: 'One', order: 0 }]);
  await store.saveContent(db, first, 1, 'keep me');
  await store.saveScratchMeta(db, second, [{ id: 1, title: 'Two', order: 0 }]);
  await store.saveContent(db, second, 1, 'other');
  await store.saveScratchMeta(db, first, [{ id: 2, title: 'Replaced', order: 0 }]);
  await store.saveContent(db, first, 2, 'new');

  const kept = await store.loadTabs(db, second);
  assert.deepEqual(kept.map((tab) => tab.title), ['Two']);
  assert.equal(kept[0].content, 'other');
  const replaced = await store.loadTabs(db, first);
  assert.deepEqual(replaced.map((tab) => tab.title), ['Replaced']);
  db.close();
});

test('absorb keeps non-empty scratch tabs and drops the source workspace', async () => {
  const db = await store.openWorkspaceDb();
  const target = 'c'.repeat(32);
  const source = 'd'.repeat(32);
  await store.saveScratchMeta(db, target, [{ id: 1, title: 'Mine', order: 0 }]);
  await store.saveContent(db, target, 1, 'mine');
  await store.saveScratchMeta(db, source, [
    { id: 1, title: 'Empty', order: 0 },
    { id: 2, title: 'Kept', order: 1 },
  ]);
  await store.saveContent(db, source, 1, '   ');
  await store.saveContent(db, source, 2, 'world');
  await store.absorbWorkspace(db, target, source);

  const tabs = await store.loadTabs(db, target);
  assert.deepEqual(tabs.map((tab) => tab.content), ['mine', 'world']);
  assert.equal(tabs[1].id === 1, false);
  assert.equal((await store.loadTabs(db, source)).length, 0);
  const workspaces = await store.listWorkspaces(db);
  assert.equal(workspaces.some((workspace) => workspace.id === source), false);
  db.close();
});

test('absorbing drops a tab the target already holds after a failed handoff', async () => {
  const db = await store.openWorkspaceDb();
  const target = '3'.repeat(32);
  const source = '4'.repeat(32);
  // The target window already adopted these two and recorded the handoff
  // origin; the source still lists them because the app exited before it
  // could remove them. Identity counts, not content — one of the copies even
  // moved on while the source kept a stale snapshot.
  await store.saveScratchMeta(db, target, [
    { id: 1, title: 'Untitled 1', order: 0, origin: { workspace: source, tab: 1 } },
    { id: 2, title: 'Untitled 2', order: 1, origin: { workspace: source, tab: 2 } },
  ]);
  await store.saveContent(db, target, 1, 'moved already');
  await store.saveContent(db, target, 2, 'edited in the new window meanwhile');
  await store.saveScratchMeta(db, source, [
    { id: 1, title: 'Untitled 1', order: 0 },
    { id: 2, title: 'Untitled 2', order: 1 },
    { id: 3, title: 'Untitled 3', order: 2 },
  ]);
  await store.saveContent(db, source, 1, 'moved already');
  await store.saveContent(db, source, 2, 'also moved');
  await store.saveContent(db, source, 3, 'genuinely new');

  await store.absorbWorkspace(db, target, source);

  const tabs = await store.loadTabs(db, target);
  assert.deepEqual(tabs.map((tab) => tab.content), [
    'moved already',
    'edited in the new window meanwhile',
    'genuinely new',
  ]);
  // The source is cleaned up either way.
  assert.equal((await store.loadTabs(db, source)).length, 0);
  assert.equal((await store.listWorkspaces(db)).some((w) => w.id === source), false);
  db.close();
});

test('absorb keeps same-titled tabs that were never handed off', async () => {
  const db = await store.openWorkspaceDb();
  const target = '5'.repeat(32);
  const source = '6'.repeat(32);
  // Same title AND same body, but no handoff origin anywhere: both must be
  // kept. Content matching must never decide what counts as a duplicate.
  await store.saveScratchMeta(db, target, [{ id: 1, title: 'notes', order: 0 }]);
  await store.saveContent(db, target, 1, 'first');
  await store.saveScratchMeta(db, source, [
    { id: 1, title: 'notes', order: 0 },
    { id: 2, title: 'notes', order: 1 },
  ]);
  await store.saveContent(db, source, 1, 'first');
  await store.saveContent(db, source, 2, 'second');

  await store.absorbWorkspace(db, target, source);

  const tabs = await store.loadTabs(db, target);
  assert.deepEqual(tabs.map((tab) => tab.content), ['first', 'first', 'second']);
  db.close();
});

test('primary startup merges unclaimed workspaces and a new window keeps its own', async () => {
  const db = await store.openWorkspaceDb();
  const older = 'e'.repeat(32);
  const newer = 'f'.repeat(32);
  await store.saveScratchMeta(db, older, [{ id: 1, title: 'Old', order: 0 }]);
  await store.saveContent(db, older, 1, 'old text');
  await delay(5);
  await store.saveScratchMeta(db, newer, [{ id: 1, title: 'New', order: 0 }]);
  await store.saveContent(db, newer, 1, 'new text');
  db.close();

  const claims = new Map();
  const claim = async (ids) => {
    const granted = [];
    ids.forEach((id) => {
      if (!claims.has(id)) {
        claims.set(id, 'caller');
        granted.push(id);
      }
    });
    return granted;
  };
  const primary = await store.bootstrap({
    role: 'primary',
    workspaceId: null,
    claim,
  });
  const contents = primary.tabs.map((tab) => tab.content).sort();
  assert.deepEqual(contents, ['new text', 'old text']);
  primary.db.close();

  const fresh = await store.bootstrap({
    role: 'new',
    workspaceId: null,
    claim,
  });
  assert.equal(fresh.tabs.length, 0);
  assert.equal(fresh.workspaceId === primary.workspaceId, false);
  fresh.db.close();
});
