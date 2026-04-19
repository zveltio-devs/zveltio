#!/usr/bin/env bun
/**
 * sync-engine-version.ts
 *
 * Copies the root package.json version into packages/engine/package.json.
 *
 * Called automatically by `bun run version-packages` after Changesets bumps
 * the root and SDK packages. Since @zveltio/engine is in the changeset ignore
 * list (it ships as a binary, not an npm package), Changesets never bumps it —
 * this script keeps it in sync with the monorepo version.
 *
 * version.ts reads ENGINE_VERSION directly from packages/engine/package.json
 * via `import pkg from '../package.json'`, so keeping that file up to date is
 * the single source of truth for what the compiled binary reports.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

const rootPkgPath = join(root, 'package.json');
const enginePkgPath = join(root, 'packages/engine/package.json');

const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8')) as { version: string };
const enginePkg = JSON.parse(readFileSync(enginePkgPath, 'utf-8')) as { version: string; [k: string]: unknown };

const newVersion = rootPkg.version;

if (enginePkg.version === newVersion) {
  console.log(`ℹ️  packages/engine/package.json already at ${newVersion} — no change needed.`);
} else {
  enginePkg.version = newVersion;
  writeFileSync(enginePkgPath, JSON.stringify(enginePkg, null, 2) + '\n', 'utf-8');
  console.log(`✅ packages/engine/package.json bumped to ${newVersion}`);
}
