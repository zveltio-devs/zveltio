#!/usr/bin/env bun
/**
 * sync-engine-version.ts — propagate the SDK's bumped version to the
 * non-Changesets-managed package.json files.
 *
 * Why this exists:
 *
 *   Changesets only sees packages declared in workspaces (packages/*). The
 *   root `zveltio` is the workspace root, not a member, so Changesets can't
 *   bump it. `@zveltio/engine`, `@zveltio/studio`, and `@zveltio/client`
 *   are explicitly in the `ignore` list (they ship as binaries or compiled
 *   bundles, not npm packages).
 *
 *   But every release needs root + engine + studio to track the SDK version
 *   so:
 *     - the engine binary reports the right version on /api/health/version
 *       (engine reads its own package.json at build time);
 *     - the Studio shows a consistent version in the footer;
 *     - the GitHub Release tag matches what the binary self-reports.
 *
 *   `client` is intentionally left alone — it's a sample SvelteKit app, not
 *   versioned with the platform.
 *
 * Called automatically by `bun run version-packages` after `changeset version`.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

// SDK is the canonical bumped version. Changesets bumped it as the head of
// the linked group [sdk, react, vue, cli], so all four are now at the same
// version. We propagate from sdk → root → engine → studio.
const sdkPkgPath = join(root, 'packages/sdk/package.json');
const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, 'utf-8')) as { version: string };
const newVersion = sdkPkg.version;

const targets = [
  { label: 'root', path: join(root, 'package.json') },
  { label: 'engine', path: join(root, 'packages/engine/package.json') },
  { label: 'studio', path: join(root, 'packages/studio/package.json') },
];

let updated = 0;
for (const { label, path } of targets) {
  const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { version: string; [k: string]: unknown };
  if (pkg.version === newVersion) {
    console.log(`ℹ️  ${label}: already at ${newVersion} — no change.`);
    continue;
  }
  pkg.version = newVersion;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`✅ ${label}: bumped to ${newVersion}`);
  updated++;
}

console.log(`\n${updated} of ${targets.length} package.json files updated to ${newVersion}.`);
