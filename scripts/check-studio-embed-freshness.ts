#!/usr/bin/env bun
/**
 * CI gate: Studio build output must carry a version marker matching package.json,
 * and engine/studio versions must stay coupled (monorepo release train).
 *
 * Prevents shipping a studio-dist built against a different engine — the admin
 * UI loads but API calls fail silently (blank page / broken widgets).
 *
 * Usage:
 *   bun run studio:build   # or packages/studio build in CI
 *   bun scripts/check-studio-embed-freshness.ts
 *
 * Env:
 *   REQUIRE_STUDIO_DIST=1  — fail if packages/studio/dist is missing (set in studio CI)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const STUDIO_PKG = join(ROOT, 'packages/studio/package.json');
const ENGINE_PKG = join(ROOT, 'packages/engine/package.json');
const STUDIO_DIST = join(ROOT, 'packages/studio/dist');
const MARKER = '.zveltio-studio-version';

function readVersion(pkgPath: string): string {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!pkg.version) throw new Error(`missing version in ${pkgPath}`);
  return pkg.version;
}

function readMarker(dir: string): string | null {
  const path = join(dir, MARKER);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim();
}

let failed = 0;

const studioVersion = readVersion(STUDIO_PKG);
const engineVersion = readVersion(ENGINE_PKG);

if (studioVersion !== engineVersion) {
  console.error(
    `❌ studio/engine version mismatch: studio=${studioVersion}, engine=${engineVersion}`,
  );
  failed++;
}

const requireDist = process.env.REQUIRE_STUDIO_DIST === '1';
const distIndex = join(STUDIO_DIST, 'index.html');

if (!existsSync(distIndex)) {
  if (requireDist) {
    console.error(`❌ packages/studio/dist missing — run: cd packages/studio && bun run build`);
    failed++;
  } else {
    console.log('⏭️  check-studio-embed: no studio dist — skip marker check');
  }
} else {
  const stamped = readMarker(STUDIO_DIST);
  if (!stamped) {
    console.error(
      `❌ ${MARKER} missing in packages/studio/dist — postbuild stamp-version did not run`,
    );
    failed++;
  } else if (stamped !== studioVersion) {
    console.error(
      `❌ studio dist stale: marker=${stamped}, package.json=${studioVersion}`,
    );
    failed++;
  }
}

// Optional local embed dirs (dev / binary prep) — warn-only unless mismatched when present
for (const label of ['packages/engine/studio-dist', 'packages/engine/src/studio-dist'] as const) {
  const dir = join(ROOT, label);
  if (!existsSync(join(dir, 'index.html'))) continue;
  const embedded = readMarker(dir);
  if (!embedded) {
    console.warn(`⚠️  ${label} has no ${MARKER} — rebuild with studio:embed`);
  } else if (embedded !== studioVersion) {
    console.error(`❌ ${label} stale: marker=${embedded}, expected ${studioVersion}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n❌ check-studio-embed: ${failed} problem(s)`);
  process.exit(1);
}

console.log(`✅ check-studio-embed: studio ${studioVersion} marker OK`);
