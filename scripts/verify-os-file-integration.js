/**
 * Temporary integration tests for OS file integration (feat/os-file-integration).
 *
 * Usage:
 *   pnpm exec electron scripts/verify-os-file-integration.js
 *   pnpm exec electron scripts/verify-os-file-integration.js startup
 *   pnpm exec electron scripts/verify-os-file-integration.js autosave
 *
 * Artifacts: scripts/.verify-files/, scripts/.verify-user-data-os-files/
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, '.verify-files');
const USER_DATA = path.join(__dirname, '.verify-user-data-os-files');

const FILE_A = path.join(FIXTURE_DIR, 'alpha.md');
const FILE_B = path.join(FIXTURE_DIR, 'beta.md');
const FILE_UNAUTHORIZED = path.join(FIXTURE_DIR, 'secret.md');
const FILE_INVALID = path.join(FIXTURE_DIR, 'notes.json');

fs.mkdirSync(FIXTURE_DIR, { recursive: true });
fs.writeFileSync(FILE_A, '# Alpha\noriginal-alpha\n');
fs.writeFileSync(FILE_B, '# Beta\noriginal-beta\n');
fs.writeFileSync(FILE_UNAUTHORIZED, '# Secret\nnever-opened\n');
fs.writeFileSync(FILE_INVALID, '{"ok":true}\n');

const TAB_STATE_SCRIPT = `
(() => {
  const errors = [];
  window.addEventListener('unhandledrejection', (e) => {
    errors.push('unhandledrejection: ' + (e.reason?.message || e.reason));
  });

  const tabs = [...document.querySelectorAll('.tab')];
  const titles = tabs.map((t) => t.querySelector('span:not(.close-tab-btn)')?.textContent || '');
  const tabIds = tabs.map((t) => t.dataset.tab);
  const activeTitle = document.querySelector('.tab.active span:not(.close-tab-btn)')?.textContent || null;

  return {
    tabCount: tabs.length,
    titles,
    tabIds,
    activeTitle,
    errors,
  };
})()
`;

const EDIT_ACTIVE_EDITOR_SCRIPT = (newContent) => `
(async () => {
  if (typeof monaco === 'undefined') {
    return { ok: false, reason: 'monaco not ready' };
  }
  const models = monaco.editor.getModels();
  if (!models.length) {
    return { ok: false, reason: 'no editor models' };
  }
  const model = models.find((m) => !m.isDisposed()) || models[0];
  model.setValue(${JSON.stringify(newContent)});
  return { ok: true, modelCount: models.length };
})()
`;

const UNAUTHORIZED_SAVE_SCRIPT = (targetPath) => `
(async () => {
  const before = document.body.textContent;
  window.electron.send('save-file-to-path', {
    filePath: ${JSON.stringify(targetPath)},
    content: 'unauthorized write attempt',
  });
  await new Promise((r) => setTimeout(r, 600));
  const notifications = [...document.querySelectorAll('div')]
    .map((el) => el.textContent)
    .filter((text) => text && text.includes('Failed to save'));
  return {
    sawErrorNotification: notifications.some((text) => text.includes('Unauthorized')),
    notifications,
  };
})()
`;

function fail(message, detail) {
  const suffix = detail ? `\n  detail: ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}` : '';
  throw new Error(`${message}${suffix}`);
}

function pass(label, detail) {
  console.log(`PASS: ${label}`);
  if (detail) console.log(`  ${detail}`);
}

async function getWindow() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) fail('no BrowserWindow');
  return win;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTabState(label) {
  const win = await getWindow();
  const state = await win.webContents.executeJavaScript(TAB_STATE_SCRIPT);
  if (state.errors?.length) {
    fail(`${label}: renderer errors`, state.errors);
  }
  return state;
}

async function sendFileOpened(filePath, content) {
  const win = await getWindow();
  const resolved = path.resolve(filePath);
  win.webContents.send('file-opened', { filePath: resolved, content });
  await wait(500);
}

async function runStartupScenario() {
  const state = await getTabState('startup');
  if (state.tabCount !== 1) fail('startup should open exactly one tab', state);
  if (!state.titles.includes('alpha.md')) fail('startup tab title should be alpha.md', state);
  pass('startup opens file from argv', `tabs: ${state.titles.join(', ')}`);

  await sendFileOpened(FILE_A, '# Alpha\nreopened-alpha\n');
  const afterDuplicate = await getTabState('duplicate-open');
  if (afterDuplicate.tabCount !== 1) {
    fail('reopening the same file should not create a duplicate tab', afterDuplicate);
  }
  pass('duplicate file path reuses existing tab', `tab count stays ${afterDuplicate.tabCount}`);

  await sendFileOpened(FILE_B, fs.readFileSync(FILE_B, 'utf8'));
  const afterSecond = await getTabState('second-file');
  if (afterSecond.tabCount !== 2) fail('second file should add a new tab', afterSecond);
  if (!afterSecond.titles.includes('beta.md')) fail('second tab should be beta.md', afterSecond);
  pass('second file opens in a new tab', `tabs: ${afterSecond.titles.join(', ')}`);

  const win = await getWindow();
  await win.webContents.executeJavaScript(`
    (async () => {
      window.electron.send('open-dropped-file', ${JSON.stringify(path.resolve(FILE_INVALID))});
      await window.electron.invoke('open-recent-file', ${JSON.stringify(path.resolve(FILE_INVALID))});
      await new Promise((r) => setTimeout(r, 500));
      return true;
    })()
  `);
  const afterInvalid = await getTabState('invalid-extension');
  if (afterInvalid.tabCount !== 2) {
    fail('invalid extension should be rejected by main process validation', afterInvalid);
  }
  pass('invalid file extension is ignored', `tab count stays ${afterInvalid.tabCount}`);
}

async function runAutosaveScenario() {
  const win = await getWindow();
  await win.webContents.executeJavaScript(`
    (async () => {
      const tab = [...document.querySelectorAll('.tab')]
        .find((el) => (el.querySelector('span:not(.close-tab-btn)')?.textContent || '') === 'alpha.md');
      if (!tab) return { ok: false, reason: 'alpha.md tab not found' };
      tab.click();
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true };
    })()
  `);

  const updated = '# Alpha\nautosaved-content\n';
  const editResult = await win.webContents.executeJavaScript(EDIT_ACTIVE_EDITOR_SCRIPT(updated));
  if (!editResult.ok) fail('failed to edit active editor', editResult);

  await wait(700);

  const onDisk = fs.readFileSync(FILE_A, 'utf8');
  if (onDisk !== updated) {
    fail('autosave should write editor content to disk', { expected: updated, actual: onDisk });
  }
  pass('autosave writes file-backed tab edits to disk', FILE_A);
}

async function runUnauthorizedSaveScenario() {
  const win = await getWindow();
  const result = await win.webContents.executeJavaScript(
    UNAUTHORIZED_SAVE_SCRIPT(path.resolve(FILE_UNAUTHORIZED)),
  );
  if (!result.sawErrorNotification) {
    fail('unauthorized save should surface an error notification', result);
  }
  const onDisk = fs.readFileSync(FILE_UNAUTHORIZED, 'utf8');
  if (onDisk !== '# Secret\nnever-opened\n') {
    fail('unauthorized path must not be modified on disk', onDisk);
  }
  pass('unauthorized save path is blocked', FILE_UNAUTHORIZED);
}

const scenario = process.argv[2] || 'all';

app.setPath('userData', USER_DATA);
process.argv = [process.argv[0], path.join(ROOT, 'src', 'main.js'), FILE_A];

require(path.join(ROOT, 'src', 'main.js'));

app.whenReady().then(async () => {
  try {
    await wait(3500);

    if (scenario === 'all' || scenario === 'startup') {
      await runStartupScenario();
    }
    if (scenario === 'all' || scenario === 'autosave') {
      await runAutosaveScenario();
    }
    if (scenario === 'all' || scenario === 'unauthorized') {
      await runUnauthorizedSaveScenario();
    }
    if (!['all', 'startup', 'autosave', 'unauthorized'].includes(scenario)) {
      fail(`unknown scenario: ${scenario}`);
    }

    console.log('\nAll requested OS file integration checks passed.');
    await app.exit(0);
  } catch (error) {
    console.error('\nVERIFY FAILED:', error.message);
    await app.exit(1);
  }
});