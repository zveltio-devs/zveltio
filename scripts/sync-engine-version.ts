#!/usr/bin/env bun
/**
 * sync-engine-version.ts
 *
 * Reads the version from packages/engine/package.json and updates
 * the ENGINE_VERSION constant in packages/engine/src/version.ts.
 *
 * Called automatically by `bun run version-packages` after Changesets
 * bumps the package.json files — so ENGINE_VERSION is always in sync.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

const pkgPath = join(root, 'packages/engine/package.json');
const versionTsPath = join(root, 'packages/engine/src/version.ts');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
const newVersion = pkg.version;

let content = readFileSync(versionTsPath, 'utf-8');
const updated = content.replace(
  /export const ENGINE_VERSION = '[^']+'/,
  `export const ENGINE_VERSION = '${newVersion}'`,
);

if (updated === content) {
  console.log(`ℹ️  ENGINE_VERSION already at ${newVersion} — no change needed.`);
} else {
  writeFileSync(versionTsPath, updated, 'utf-8');
  console.log(`✅ ENGINE_VERSION updated to ${newVersion}`);
}
