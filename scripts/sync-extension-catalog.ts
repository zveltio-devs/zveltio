#!/usr/bin/env bun
/**
 * sync-extension-catalog.ts — copy each first-party extension's manifest
 * facts into the engine's bundled catalogue and the public catalogue page.
 *
 * What was broken: `packages/engine/src/lib/extensions/catalog.json` and
 * `docs/extensions/catalog.md` were written by hand on 2026-09-02 and never
 * updated. By 2026-11-13, 52 of 52 first-party entries carried a stale version
 * (`auth/scim` said 1.0.3 while 3.0.0 shipped), and several a stale
 * description and permission list. The registry's list wins when it answers,
 * so the stale copy only showed on an instance that cannot reach it — the
 * isolated install the bundled catalogue exists for.
 *
 * The fix: the manifests are the source; this script copies name, category,
 * version, description and permissions out of them. Tags and author stay as
 * written — manifests do not carry them. Run it when cutting a release
 * (docs/platform/versioning.md). It refuses when an extension exists on one
 * side only, because adding or removing a catalogue entry is a decision, not a
 * copy.
 *
 * Usage: bun run sync-catalog   (EXTENSIONS_ROOT overrides the sibling path)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import { requireSibling, SIBLING_ROOT } from './lib/require-sibling.js';

requireSibling(SIBLING_ROOT, 'sync-extension-catalog', { strict: true });

const ROOT = join(import.meta.dir, '..');
const JSON_PATH = join(ROOT, 'packages/engine/src/lib/extensions/catalog.json');
const MD_PATH = join(ROOT, 'docs/extensions/catalog.md');

interface Manifest {
  name: string;
  displayName: string;
  category: string;
  description: string;
  version: string;
  permissions?: string[];
}

const manifests = new Map<string, Manifest>();
for (const path of new Glob('**/manifest.json').scanSync(SIBLING_ROOT)) {
  if (path.includes('node_modules')) continue;
  const m = JSON.parse(readFileSync(join(SIBLING_ROOT, path), 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const file = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as {
  entries: Array<Record<string, unknown> & { name: string }>;
};
// The hello-ext* entries are smoke fixtures that live in this repo, not there.
const isFixture = (name: string) => name.startsWith('hello-ext');
const listed = new Set(file.entries.map((e) => e.name).filter((n) => !isFixture(n)));
const onlyCatalog = [...listed].filter((n) => !manifests.has(n));
const onlyManifest = [...manifests.keys()].filter((n) => !listed.has(n));
if (onlyCatalog.length || onlyManifest.length) {
  console.error(
    `sync-extension-catalog: catalogue and manifests list different extensions.\n` +
      `  in catalog.json only: ${onlyCatalog.join(', ') || '-'}\n` +
      `  in manifests only:    ${onlyManifest.join(', ') || '-'}\n` +
      'Add or remove the entry by hand, then run again.',
  );
  process.exit(1);
}

for (const entry of file.entries) {
  const m = manifests.get(entry.name);
  if (!m) continue;
  entry.displayName = m.displayName;
  entry.category = m.category;
  entry.version = m.version;
  entry.description = m.description;
  entry.permissions = m.permissions ?? [];
}
writeFileSync(JSON_PATH, `${JSON.stringify(file, null, 2)}\n`);

// Rows look like: | `auth/scim` | SCIM Provisioning | 3.0.0 | description |
const rowsSeen = new Set<string>();
const md = readFileSync(MD_PATH, 'utf8').replace(
  /^\| `([^`]+)` \| [^|]* \| [^|]* \| .* \|$/gm,
  (row, name: string) => {
    const m = manifests.get(name);
    if (!m) return row;
    rowsSeen.add(name);
    return `| \`${name}\` | ${m.displayName} | ${m.version} | ${m.description.replaceAll('|', '\\|')} |`;
  },
);
const missingRows = [...manifests.keys()].filter((n) => !rowsSeen.has(n));
if (missingRows.length) {
  console.error(`sync-extension-catalog: no row in catalog.md for ${missingRows.join(', ')}`);
  process.exit(1);
}
writeFileSync(MD_PATH, md);
console.log(`sync-extension-catalog: ${manifests.size} extensions copied from ${SIBLING_ROOT}`);
