#!/usr/bin/env node

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Recursively collect all regular file paths under `dir`.
 * @param {string} dir
 * @returns {string[]}
 */
export function walkFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (stats.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * GitHub Releases replaces spaces in uploaded asset filenames with dots.
 * @param {string} filename
 * @returns {string}
 */
export function sanitizeGitHubAssetName(filename) {
  return filename.replace(/\s+/g, '.');
}

/**
 * Find the matching asset and its `.sig` file from `files`.
 * @param {string[]} files
 * @param {(filename: string) => boolean} predicate
 * @param {string} label
 * @returns {{ assetPath: string, sigPath: string }}
 */
function findSignedAsset(files, predicate, label) {
  const matches = files.filter((filePath) => {
    const base = path.basename(filePath);
    return !base.endsWith('.sig') && predicate(base);
  });
  if (matches.length === 0) {
    throw new Error(`Missing updater asset for ${label}`);
  }
  if (matches.length > 1) {
    const names = matches.map((filePath) => path.basename(filePath)).join(', ');
    throw new Error(`Ambiguous updater assets for ${label}: ${names}`);
  }
  const assetPath = matches[0];
  const sigPath = `${assetPath}.sig`;
  if (!files.includes(sigPath)) {
    throw new Error(`Missing signature file for ${label}: ${path.basename(sigPath)}`);
  }
  return { assetPath, sigPath };
}

/**
 * Build Tauri updater `latest.json` object from a directory of release artifacts.
 * @param {object} options
 * @param {string} options.distDir
 * @param {string} options.tag
 * @param {string} options.repo
 * @param {string} [options.notes]
 * @param {string} [options.pubDate]
 * @returns {object}
 */
export function generateUpdaterManifest({
  distDir,
  tag,
  repo,
  notes = `Release ${tag}`,
  pubDate = new Date().toISOString(),
}) {
  if (!tag?.startsWith('v')) {
    throw new Error(`Invalid release tag: ${tag || '(missing)'}`);
  }
  if (!repo) {
    throw new Error('Repository slug (owner/name) is required');
  }

  const version = tag.slice(1);
  const files = walkFiles(distDir);

  const platformSpecs = [
    {
      target: 'darwin-aarch64',
      match: (name) => name.endsWith('.app.tar.gz'),
    },
    {
      target: 'windows-x86_64',
      match: (name) => name.endsWith('-setup.exe'),
    },
    {
      target: 'linux-x86_64-appimage',
      match: (name) => name.endsWith('.AppImage'),
    },
    {
      target: 'linux-x86_64-deb',
      match: (name) => name.endsWith('.deb'),
    },
  ];

  const platforms = {};
  for (const spec of platformSpecs) {
    const { assetPath, sigPath } = findSignedAsset(files, spec.match, spec.target);
    const signature = readFileSync(sigPath, 'utf8').trim();
    if (!signature) {
      throw new Error(`Empty signature file for ${spec.target}: ${path.basename(sigPath)}`);
    }
    const assetName = sanitizeGitHubAssetName(path.basename(assetPath));
    platforms[spec.target] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName)}`,
    };
  }

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms,
  };
}

function main() {
  const distDir = process.argv[2] || 'dist';
  const outPath = process.argv[3] || path.join(distDir, 'latest.json');
  const tag = process.env.RELEASE_TAG;
  const repo = process.env.GITHUB_REPOSITORY || 'izumiz-dev/sainte-devote';

  const manifest = generateUpdaterManifest({ distDir, tag, repo });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`Generated updater manifest at ${outPath} for ${tag}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
