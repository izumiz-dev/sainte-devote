#!/usr/bin/env node
// Copies the frontend's runtime dependencies from node_modules into
// frontend/vendor/ as real files (not symlinks).
//
// pnpm lays node_modules out as a tree of symlinks into .pnpm/*/node_modules.
// Tauri's static asset server does not follow those symlinks when serving
// frontendDist, so a naive reference to node_modules/<pkg> 404s at runtime
// (discovered during the Phase 0 spike: monaco-editor's loader.js came back
// as an HTML 404 page instead of JS). Copying with fs.cpSync's default
// dereference behavior resolves the links once, at vendor time, instead of
// requiring the asset server to do it on every request.

import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const nodeModules = path.join(rootDir, 'node_modules');
const vendorDir = path.join(rootDir, 'frontend', 'vendor');

// [sourceRelativeToNodeModules, destRelativeToVendorDir]
const targets = [
  ['dompurify/dist', 'dompurify/dist'],
  ['monaco-editor/min', 'monaco-editor/min'],
  ['monaco-editor/min-maps', 'monaco-editor/min-maps'],
  ['marked', 'marked'],
  ['@highlightjs/cdn-assets', '@highlightjs/cdn-assets'],
  ['github-markdown-css', 'github-markdown-css'],
];

rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });

for (const [src, dest] of targets) {
  const srcPath = path.join(nodeModules, src);
  const destPath = path.join(vendorDir, dest);
  if (!existsSync(srcPath)) {
    throw new Error(`vendor.mjs: missing source ${srcPath}. Run pnpm install first.`);
  }
  mkdirSync(path.dirname(destPath), { recursive: true });
  cpSync(srcPath, destPath, { recursive: true, dereference: true });
}

// eslint-disable-next-line no-console
console.log(`vendor.mjs: copied ${targets.length} package(s) into ${path.relative(rootDir, vendorDir)}/`);
