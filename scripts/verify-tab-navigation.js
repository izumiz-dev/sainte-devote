/**
 * Automated verification for tab-navigation / IndexedDB race fixes.
 *
 * Usage:
 *   electron scripts/verify-tab-navigation.js fresh-files
 *   electron scripts/verify-tab-navigation.js seed-restored
 *   electron scripts/verify-tab-navigation.js restored-files
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, '.verify-tabs');
const FILE_A = path.join(FIXTURE_DIR, 'alpha.md');
const FILE_B = path.join(FIXTURE_DIR, 'beta.md');

fs.mkdirSync(FIXTURE_DIR, { recursive: true });
fs.writeFileSync(FILE_A, '# Alpha\ncontent-a\n');
fs.writeFileSync(FILE_B, '# Beta\ncontent-b\n');

const VERIFY_SCRIPT = `
(async () => {
  const errors = [];
  window.addEventListener('unhandledrejection', (e) => {
    errors.push('unhandledrejection: ' + (e.reason?.message || e.reason));
  });
  await new Promise((r) => setTimeout(r, 500));

  const tabs = [...document.querySelectorAll('.tab')];
  const editors = [...document.querySelectorAll('.editor')];
  const tabIds = tabs.map((t) => t.dataset.tab);
  const titles = tabs.map((t) => t.querySelector('span:not(.close-tab-btn)')?.textContent || '');
  const editorIds = editors.map((e) => e.dataset.tab);

  const duplicateTabIds = tabIds.filter((id, i) => tabIds.indexOf(id) !== i);
  const duplicateEditorIds = editorIds.filter((id, i) => editorIds.indexOf(id) !== i);

  async function clickTab(index) {
    const tab = document.querySelectorAll('.tab')[index];
    if (!tab) return { ok: false, reason: 'tab missing at index ' + index };
    const tabId = tab.dataset.tab;
    tab.click();
    await new Promise((r) => setTimeout(r, 300));
    const active = document.querySelector('.tab.active');
    const activeId = active?.dataset.tab;
    const editorVisible = document.querySelector('.editor[data-tab="' + tabId + '"]')?.style.display !== 'none';
    return {
      ok: String(activeId) === String(tabId),
      tabId,
      activeId,
      editorVisible,
      title: tab.querySelector('span:not(.close-tab-btn)')?.textContent,
    };
  }

  const switchResults = [];
  for (let i = 0; i < tabs.length; i++) {
    switchResults.push({ index: i, ...(await clickTab(i)) });
  }

  return {
    tabCount: tabs.length,
    editorCount: editors.length,
    titles,
    tabIds,
    duplicateTabIds,
    duplicateEditorIds,
    switchResults,
    errors,
  };
})()
`;

function assertState(label, state, expectations) {
  const failures = [...state.errors];
  if (state.duplicateTabIds.length) {
    failures.push(`duplicate tab ids: ${state.duplicateTabIds.join(', ')}`);
  }
  if (state.duplicateEditorIds.length) {
    failures.push(`duplicate editor ids: ${state.duplicateEditorIds.join(', ')}`);
  }
  if (state.tabCount !== expectations.tabCount) {
    failures.push(`expected ${expectations.tabCount} tabs, got ${state.tabCount}`);
  }
  for (const title of expectations.titles) {
    if (!state.titles.includes(title)) {
      failures.push(`missing tab title "${title}" (got: ${state.titles.join(', ')})`);
    }
  }
  for (const sw of state.switchResults) {
    if (!sw.ok) {
      failures.push(`tab index ${sw.index} ("${sw.title}") failed to activate (wanted ${sw.tabId}, active ${sw.activeId})`);
    }
  }
  if (failures.length) {
    throw new Error(`${label} failed:\n  - ${failures.join('\n  - ')}\n  state: ${JSON.stringify(state, null, 2)}`);
  }
  console.log(`PASS: ${label}`);
  console.log(`  tabs: ${state.titles.join(', ')}`);
  console.log(`  all ${state.switchResults.length} tab switches OK`);
}

async function inspect(label) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error(`${label}: no BrowserWindow`);
  await new Promise((r) => setTimeout(r, 3500));
  return win.webContents.executeJavaScript(VERIFY_SCRIPT);
}

const scenario = process.argv[2] || 'fresh-files';

if (scenario === 'fresh-files') {
  app.setPath('userData', path.join(__dirname, '.verify-user-data-fresh'));
  process.argv = [process.argv[0], path.join(ROOT, 'src', 'main.js'), FILE_A, FILE_B];
} else if (scenario === 'seed-restored') {
  app.setPath('userData', path.join(__dirname, '.verify-user-data-restored'));
  process.argv = [process.argv[0], path.join(ROOT, 'src', 'main.js')];
} else if (scenario === 'restored-files') {
  app.setPath('userData', path.join(__dirname, '.verify-user-data-restored'));
  process.argv = [process.argv[0], path.join(ROOT, 'src', 'main.js'), FILE_A, FILE_B];
} else {
  console.error(`Unknown scenario: ${scenario}`);
  process.exit(1);
}

require(path.join(ROOT, 'src', 'main.js'));

app.whenReady().then(async () => {
  try {
    if (scenario === 'fresh-files') {
      const state = await inspect('fresh-files');
      assertState('fresh profile + two startup files', state, {
        tabCount: 2,
        titles: ['alpha.md', 'beta.md'],
      });
    } else if (scenario === 'seed-restored') {
      await inspect('seed-restored');
      console.log('PASS: seeded scratch tab in IndexedDB');
    } else if (scenario === 'restored-files') {
      const state = await inspect('restored-files');
      assertState('restored scratch tab + two startup files', state, {
        tabCount: 3,
        titles: ['Untitled 1', 'alpha.md', 'beta.md'],
      });
    }
    await app.exit(0);
  } catch (error) {
    console.error('VERIFY FAILED:', error.message);
    await app.exit(1);
  }
});