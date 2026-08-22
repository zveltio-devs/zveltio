#!/usr/bin/env bun
/**
 * CI gate: extension SDUI schema files must declare sduiSchema + title.
 *
 * Scans `EXTENSIONS_DIR` (default: sibling ../zveltio-extensions) for
 * `studio/schemas/*.json` referenced by manifest studio.pages[].schema.
 *
 * Usage: bun scripts/check-extension-sdui-schemas.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const EXT_ROOT =
  process.env.EXTENSIONS_DIR ??
  (statSync(join(ROOT, '../zveltio-extensions'), { throwIfNoEntry: false })
    ? join(ROOT, '../zveltio-extensions')
    : null);

if (!EXT_ROOT) {
  console.log('⏭️  check-sdui-schemas: no EXTENSIONS_DIR / zveltio-extensions — skip');
  process.exit(0);
}

const SDUI_MAX = 1; // keep in sync with packages/studio/src/lib/sdui/types.ts

function findManifests(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const st = statSync(full);
    if (st.isDirectory()) findManifests(full, acc);
    else if (name === 'manifest.json') acc.push(full);
  }
  return acc;
}

let failed = 0;

for (const manifestPath of findManifests(EXT_ROOT)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: string;
    studio?: { pages?: Array<{ schema?: string }> };
  };
  const extDir = join(manifestPath, '..');
  const extName = manifest.name ?? relative(EXT_ROOT, extDir);

  for (const page of manifest.studio?.pages ?? []) {
    if (typeof page.schema !== 'string') continue;
    const schemaPath = join(extDir, 'studio', page.schema);
    let raw: string;
    try {
      raw = readFileSync(schemaPath, 'utf8');
    } catch {
      console.error(`❌ ${extName}: schema file missing: studio/${page.schema}`);
      failed++;
      continue;
    }
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error(`❌ ${extName}: invalid JSON: studio/${page.schema}`);
      failed++;
      continue;
    }
    const version = typeof schema.sduiSchema === 'number' ? schema.sduiSchema : null;
    if (version === null) {
      console.error(`❌ ${extName}: studio/${page.schema} missing "sduiSchema"`);
      failed++;
    } else if (version > SDUI_MAX) {
      console.error(
        `❌ ${extName}: studio/${page.schema} sduiSchema=${version} > host max ${SDUI_MAX}`,
      );
      failed++;
    }
    if (typeof schema.title !== 'string' || !schema.title) {
      console.error(`❌ ${extName}: studio/${page.schema} missing "title"`);
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`\n❌ check-sdui-schemas: ${failed} problem(s)`);
  process.exit(1);
}

console.log('✅ check-sdui-schemas: extension SDUI schemas OK');
