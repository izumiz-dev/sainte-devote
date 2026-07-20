#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const releaseTag = process.env.RELEASE_TAG;
if (!releaseTag?.startsWith('v')) {
  throw new Error(`Invalid release tag: ${releaseTag || '(missing)'}`);
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const tauriConfig = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)),
);
const cargoMetadata = spawnSync(
  'cargo',
  [
    'metadata',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--format-version',
    '1',
    '--no-deps',
  ],
  { encoding: 'utf8' },
);

if (cargoMetadata.status !== 0) {
  throw new Error(cargoMetadata.stderr || 'cargo metadata failed');
}

const metadata = JSON.parse(cargoMetadata.stdout);
const rustPackage = metadata.packages.find((entry) => entry.name === 'sainte-devote');
if (!rustPackage) {
  throw new Error('sainte-devote package was not found in Cargo metadata');
}

const expectedVersion = releaseTag.slice(1);
const versions = {
  'package.json': packageJson.version,
  'src-tauri/Cargo.toml': rustPackage.version,
  'src-tauri/tauri.conf.json': tauriConfig.version,
};
const mismatches = Object.entries(versions).filter(([, version]) => version !== expectedVersion);

if (mismatches.length > 0) {
  const detail = mismatches.map(([file, version]) => `${file}=${version}`).join(', ');
  throw new Error(`Tag ${releaseTag} expects ${expectedVersion}; mismatched versions: ${detail}`);
}

process.stdout.write(`Release versions match ${releaseTag}\n`);
