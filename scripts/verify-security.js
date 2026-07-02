/**
 * Security verification for OS file integration and IPC surface.
 *
 * Usage:
 *   pnpm exec electron scripts/verify-security.js
 *
 * Artifacts: scripts/.verify-security/, scripts/.verify-user-data-security/
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, '.verify-security');
const USER_DATA = path.join(__dirname, '.verify-user-data-security');

const FILE_OPENED = path.join(FIXTURE_DIR, 'opened.md');
const FILE_SECRET = path.join(FIXTURE_DIR, 'secret.txt');
const FILE_NULL = path.join(FIXTURE_DIR, 'nullbyte.md');

fs.mkdirSync(FIXTURE_DIR, { recursive: true });
fs.writeFileSync(FILE_OPENED, '# Opened\nopened-content\n');
fs.writeFileSync(FILE_SECRET, 'TOP-SECRET-DATA\n');
fs.writeFileSync(FILE_NULL, 'null-byte-target\n');

const findings = [];

function record(severity, id, message) {
  findings.push({ severity, id, message });
}

function pass(label, detail) {
  console.log(`PASS: ${label}`);
  if (detail) console.log(`  ${detail}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}`);
  if (detail) console.error(`  ${detail}`);
  throw new Error(label);
}

async function getWindow() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('no BrowserWindow');
  return win;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function tabState() {
  const win = await getWindow();
  return win.webContents.executeJavaScript(`
    ({
      tabCount: document.querySelectorAll('.tab').length,
      titles: [...document.querySelectorAll('.tab')].map(
        (t) => t.querySelector('span:not(.close-tab-btn)')?.textContent || ''
      ),
      editorText: (typeof monaco !== 'undefined' && monaco.editor.getModels()[0])
        ? monaco.editor.getModels()[0].getValue()
        : null,
    })
  `);
}

async function runIpcAllowlistChecks() {
  const win = await getWindow();
  const blocked = await win.webContents.executeJavaScript(`
    (async () => {
      const attempts = [];
      window.electron.send('fs-readFile', '/etc/passwd');
      attempts.push('send-fs-readFile');
      try {
        await window.electron.invoke('shell-openExternal', 'file:///etc/passwd');
        attempts.push('invoke-shell-openExternal-allowed');
      } catch {
        attempts.push('invoke-shell-openExternal-blocked');
      }
      return attempts;
    })()
  `);
  if (!blocked.includes('invoke-shell-openExternal-blocked')) {
    fail('IPC invoke allowlist should block unknown channels', blocked);
  }
  pass('IPC invoke allowlist blocks unknown channels');
}

async function runOpenExternalChecks() {
  const win = await getWindow();
  const openCalls = [];
  const original = require('electron').shell.openExternal;
  require('electron').shell.openExternal = (url) => {
    openCalls.push(url);
  };

  await win.webContents.executeJavaScript(`
    window.electron.send('open-external', 'file:///etc/passwd');
    window.electron.send('open-external', 'javascript:alert(1)');
    window.electron.send('open-external', 'https://example.com/safe');
  `);
  await wait(200);
  require('electron').shell.openExternal = original;

  if (openCalls.some((url) => String(url).startsWith('file:'))) {
    fail('open-external must block file:// URLs', openCalls);
  }
  if (openCalls.some((url) => String(url).startsWith('javascript:'))) {
    fail('open-external must block javascript: URLs', openCalls);
  }
  if (!openCalls.includes('https://example.com/safe')) {
    fail('open-external should allow https URLs', openCalls);
  }
  pass('open-external protocol filter', `allowed: ${openCalls.join(', ')}`);
}

async function runUnauthorizedSaveCheck() {
  const win = await getWindow();
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      window.electron.send('save-file-to-path', {
        filePath: ${JSON.stringify(path.resolve(FILE_SECRET))},
        content: 'malicious overwrite',
      });
      await new Promise((r) => setTimeout(r, 600));
      return document.body.textContent.includes('Unauthorized');
    })()
  `);
  const onDisk = fs.readFileSync(FILE_SECRET, 'utf8');
  if (!result || onDisk !== 'TOP-SECRET-DATA\n') {
    fail('save-file-to-path should block paths outside activeFilePaths', { result, onDisk });
  }
  pass('save-file-to-path rejects unauthorized paths');
}

async function runArbitraryReadCheck() {
  const before = await tabState();
  const win = await getWindow();
  const attack = await win.webContents.executeJavaScript(`
    (async () => {
      const target = ${JSON.stringify(path.resolve(FILE_SECRET))};
      const attempts = [];

      window.electron.send('open-dropped-file', target);
      attempts.push('send-open-dropped-file');

      try {
        await window.electron.invoke('open-dropped-files', [target]);
        attempts.push('invoke-open-dropped-files-allowed');
      } catch {
        attempts.push('invoke-open-dropped-files-blocked');
      }

      try {
        const recent = await window.electron.invoke('open-recent-file', target);
        attempts.push(recent?.ok ? 'invoke-open-recent-file-allowed' : 'invoke-open-recent-file-blocked');
      } catch {
        attempts.push('invoke-open-recent-file-error');
      }

      await new Promise((r) => setTimeout(r, 700));

      const titles = [...document.querySelectorAll('.tab')].map(
        (t) => t.querySelector('span:not(.close-tab-btn)')?.textContent || ''
      );
      return {
        attempts,
        tabCount: document.querySelectorAll('.tab').length,
        titles,
        openedSecret: titles.includes('secret.txt'),
      };
    })()
  `);

  if (attack.openedSecret || attack.tabCount > before.tabCount) {
    record(
      'high',
      'SEC-001',
      'Renderer can still open arbitrary local files without user confirmation.',
    );
    fail('renderer-initiated arbitrary file read must remain blocked', attack);
  }

  if (!attack.attempts.includes('invoke-open-dropped-files-blocked')) {
    fail('open-dropped-files must not be exposed via generic invoke', attack.attempts);
  }

  pass('renderer cannot read arbitrary files via forged IPC paths', attack.attempts.join(', '));
}

async function runCloseFileRevokesWriteCheck() {
  const win = await getWindow();
  await win.webContents.executeJavaScript(`
    window.electron.send('close-file', ${JSON.stringify(path.resolve(FILE_OPENED))});
  `);
  await wait(200);

  const blocked = await win.webContents.executeJavaScript(`
    (async () => {
      window.electron.send('save-file-to-path', {
        filePath: ${JSON.stringify(path.resolve(FILE_OPENED))},
        content: 'post-close write',
      });
      await new Promise((r) => setTimeout(r, 600));
      return document.body.textContent.includes('Unauthorized');
    })()
  `);
  const onDisk = fs.readFileSync(FILE_OPENED, 'utf8');
  if (!blocked || onDisk.includes('post-close write')) {
    fail('close-file should revoke write access via activeFilePaths', onDisk);
  }
  pass('close-file revokes autosave authorization');
}

async function runInvalidPathChecks() {
  const win = await getWindow();
  const before = await tabState();

  await win.webContents.executeJavaScript(`
    (async () => {
      const paths = [
        ${JSON.stringify(FILE_NULL + '\0.md')},
        ${JSON.stringify(path.join(FIXTURE_DIR, 'missing.md'))},
        ${JSON.stringify(path.join(FIXTURE_DIR, 'payload.exe'))},
      ];
      for (const target of paths) {
        window.electron.send('open-dropped-file', target);
        await window.electron.invoke('open-recent-file', target);
      }
      await new Promise((r) => setTimeout(r, 500));
    })()
  `);
  const after = await tabState();

  if (after.tabCount !== before.tabCount) {
    fail('invalid paths should not open new tabs', { before, after });
  }
  pass('null-byte, missing, and disallowed extensions are rejected');
}

async function runSymlinkReadCheck() {
  const linkPath = path.join(FIXTURE_DIR, 'link.md');
  try {
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    fs.symlinkSync(FILE_SECRET, linkPath);
  } catch (error) {
    pass('symlink read check skipped (platform permissions)', error.message);
    return;
  }

  const before = await tabState();
  const win = await getWindow();
  await win.webContents.executeJavaScript(`
    window.electron.invoke('open-recent-file', ${JSON.stringify(path.resolve(linkPath))});
  `);
  await wait(500);
  const after = await tabState();

  try {
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
  } catch {
    // ignore cleanup errors
  }

  if (after.tabCount > before.tabCount) {
    fail('symlink paths must not be opened for read', { before, after });
  }
  pass('symlink paths are rejected on read');
}

app.setPath('userData', USER_DATA);
process.argv = [process.argv[0], path.join(ROOT, 'src', 'main.js'), FILE_OPENED];

require(path.join(ROOT, 'src', 'main.js'));

app.whenReady().then(async () => {
  try {
    await wait(3500);

    await runIpcAllowlistChecks();
    await runOpenExternalChecks();
    await runUnauthorizedSaveCheck();
    await runArbitraryReadCheck();
    await runCloseFileRevokesWriteCheck();
    await runInvalidPathChecks();
    await runSymlinkReadCheck();

    console.log('\n--- Security findings ---');
    if (!findings.length) {
      console.log('No additional risks detected beyond checks.');
    } else {
      for (const item of findings) {
        console.log(`[${item.severity.toUpperCase()}] ${item.id}: ${item.message}`);
      }
    }

    console.log('\nSecurity verification completed.');
    await app.exit(0);
  } catch (error) {
    console.error('\nSECURITY VERIFY FAILED:', error.message);
    await app.exit(1);
  }
});