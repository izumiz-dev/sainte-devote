import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  generateUpdaterManifest,
  sanitizeGitHubAssetName,
} from './generate-updater-manifest.mjs';

function createTempDist() {
  return mkdtempSync(path.join(tmpdir(), 'sainte-devote-manifest-'));
}

describe('generate-updater-manifest', () => {
  it('sanitizes spaces in GitHub release asset names to dots', () => {
    assert.equal(
      sanitizeGitHubAssetName('Sainte Devote_2.2.2_x64-setup.exe'),
      'Sainte.Devote_2.2.2_x64-setup.exe',
    );
  });

  it('builds a valid latest.json manifest from signed platform artifacts (including flat root files)', () => {
    const dir = createTempDist();
    try {
      mkdirSync(path.join(dir, 'macos'), { recursive: true });
      mkdirSync(path.join(dir, 'appimage'), { recursive: true });
      mkdirSync(path.join(dir, 'deb'), { recursive: true });

      writeFileSync(path.join(dir, 'macos', 'Sainte Devote.app.tar.gz'), 'mac-tar');
      writeFileSync(path.join(dir, 'macos', 'Sainte Devote.app.tar.gz.sig'), 'sig-mac\n');
      // Windows artifacts land directly under dist/ when download-artifact strips the single shared parent.
      writeFileSync(path.join(dir, 'Sainte Devote_2.3.0_x64-setup.exe'), 'win-exe');
      writeFileSync(path.join(dir, 'Sainte Devote_2.3.0_x64-setup.exe.sig'), 'sig-win\n');
      writeFileSync(
        path.join(dir, 'appimage', 'Sainte Devote_2.3.0_amd64.AppImage'),
        'linux-appimage',
      );
      writeFileSync(
        path.join(dir, 'appimage', 'Sainte Devote_2.3.0_amd64.AppImage.sig'),
        'sig-appimage\n',
      );
      writeFileSync(path.join(dir, 'deb', 'Sainte Devote_2.3.0_amd64.deb'), 'linux-deb');
      writeFileSync(path.join(dir, 'deb', 'Sainte Devote_2.3.0_amd64.deb.sig'), 'sig-deb\n');

      const manifest = generateUpdaterManifest({
        distDir: dir,
        tag: 'v2.3.0',
        repo: 'izumiz-dev/sainte-devote',
        pubDate: '2026-11-23T00:00:00Z',
      });

      assert.equal(manifest.version, '2.3.0');
      assert.equal(manifest.pub_date, '2026-11-23T00:00:00Z');
      assert.deepEqual(manifest.platforms['darwin-aarch64'], {
        signature: 'sig-mac',
        url: 'https://github.com/izumiz-dev/sainte-devote/releases/download/v2.3.0/Sainte.Devote.app.tar.gz',
      });
      assert.deepEqual(manifest.platforms['windows-x86_64'], {
        signature: 'sig-win',
        url: 'https://github.com/izumiz-dev/sainte-devote/releases/download/v2.3.0/Sainte.Devote_2.3.0_x64-setup.exe',
      });
      assert.deepEqual(manifest.platforms['linux-x86_64-appimage'], {
        signature: 'sig-appimage',
        url: 'https://github.com/izumiz-dev/sainte-devote/releases/download/v2.3.0/Sainte.Devote_2.3.0_amd64.AppImage',
      });
      assert.deepEqual(manifest.platforms['linux-x86_64-deb'], {
        signature: 'sig-deb',
        url: 'https://github.com/izumiz-dev/sainte-devote/releases/download/v2.3.0/Sainte.Devote_2.3.0_amd64.deb',
      });
      assert.equal(manifest.platforms['linux-x86_64'], undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when a signature file is missing', () => {
    const dir = createTempDist();
    try {
      writeFileSync(path.join(dir, 'Sainte Devote.app.tar.gz'), 'mac-tar');
      assert.throws(
        () =>
          generateUpdaterManifest({
            distDir: dir,
            tag: 'v2.3.0',
            repo: 'izumiz-dev/sainte-devote',
          }),
        /Missing signature file for darwin-aarch64/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when multiple assets match the same platform target', () => {
    const dir = createTempDist();
    try {
      writeFileSync(path.join(dir, 'a.app.tar.gz'), 'mac-a');
      writeFileSync(path.join(dir, 'a.app.tar.gz.sig'), 'sig-a');
      writeFileSync(path.join(dir, 'b.app.tar.gz'), 'mac-b');
      writeFileSync(path.join(dir, 'b.app.tar.gz.sig'), 'sig-b');
      assert.throws(
        () =>
          generateUpdaterManifest({
            distDir: dir,
            tag: 'v2.3.0',
            repo: 'izumiz-dev/sainte-devote',
          }),
        /Ambiguous updater assets for darwin-aarch64/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
