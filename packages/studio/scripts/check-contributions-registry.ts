#!/usr/bin/env bun
/**
 * Verify the committed contributions registry matches `.synced.json` and that
 * every listed module exists on disk. Catches stale registry entries that
 * would break `vite build` on PR runners without the extensions sibling checkout.
 */

import { existsSync } from 'fs';
import { join } from 'path';

const STUDIO_ROOT = join(import.meta.dir, '..');
const LIB_EXT = join(STUDIO_ROOT, 'src/lib/ext');
const MANIFEST = join(LIB_EXT, '.synced.json');
const REGISTRY = join(LIB_EXT, '.contributions.generated.ts');

function fail(msg: string): never {
  console.error(`[check-contributions] ${msg}`);
  process.exit(1);
}

if (!existsSync(REGISTRY)) {
  fail('missing src/lib/ext/.contributions.generated.ts — run sync-extensions');
}

const manifest = existsSync(MANIFEST)
  ? ((JSON.parse(await Bun.file(MANIFEST).text()) as { contributions?: string[] }).contributions ??
    [])
  : [];

const expected = [...manifest].sort();
const registryText = await Bun.file(REGISTRY).text();

for (const name of expected) {
  if (!registryText.includes(`${JSON.stringify(name)}:`)) {
    fail(
      `registry missing entry for "${name}" — run: cd packages/studio && bun scripts/sync-extensions.ts`,
    );
  }
  const contributePath = join(LIB_EXT, name, 'contribute.ts');
  if (!existsSync(contributePath)) {
    fail(`stale registry entry "${name}" — missing ${contributePath}`);
  }
}

// Every import key in the registry must be listed in the manifest when manifest exists.
if (existsSync(MANIFEST)) {
  const keys = [...registryText.matchAll(/^\s*"([^"]+)":\s*\(\)\s*=>/gm)].map((m) => m[1]);
  for (const key of keys.sort()) {
    if (!expected.includes(key)) {
      fail(`registry lists "${key}" but .synced.json contributions does not — run sync-extensions`);
    }
  }
}

console.log(`[check-contributions] OK — ${expected.length} contribution module(s)`);
