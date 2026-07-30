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

// The Helm chart's appVersion is what `helm install` resolves the image tag from
// when the operator does not pin one. Left to drift it had reached
// 1.0.0-alpha.80 while the engine was on 3.0.0-beta.x, so a default install
// silently deployed a months-old image. It is a release artefact like the
// package.json versions, so it is synced here rather than by hand.
const chartPath = join(root, 'charts/zveltio/Chart.yaml');
try {
  const chart = readFileSync(chartPath, 'utf-8');
  const next = chart.replace(/^appVersion:\s*.*$/m, `appVersion: "${newVersion}"`);
  if (next !== chart) {
    writeFileSync(chartPath, next, 'utf-8');
    console.log(`✅ helm chart: appVersion bumped to ${newVersion}`);
  } else {
    console.log(`ℹ️  helm chart: already at ${newVersion} — no change.`);
  }
} catch (err) {
  console.warn(`⚠️  helm chart: could not sync appVersion — ${(err as Error).message}`);
}
