#!/usr/bin/env bun
/**
 * Validate every extension under zveltio-extensions and emit a summary report.
 * Usage: bun scripts/validate-all-extensions.ts [extensions-root]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

const ROOT = process.argv[2] ?? join(import.meta.dir, '../../zveltio-extensions');
const CLI = join(import.meta.dir, '../packages/cli/src/index.ts');

function findManifests(dir: string, acc: string[] = []): string[] {
  for (const ent of readdirSync(dir)) {
    if (ent === 'node_modules' || ent === '.git') continue;
    const p = join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) findManifests(p, acc);
    else if (ent === 'manifest.json') acc.push(p);
  }
  return acc;
}

type Row = {
  name: string;
  tier: 'sdui' | 'bespoke' | 'no-studio';
  sduiOk: boolean | null;
  sduiErrors: string[];
  validateOk: boolean;
  otherErrors: string[];
  hasEngine: boolean;
  hasBundle: boolean;
  bundleHashOk: boolean | null;
  studioPages: number;
};

const rows: Row[] = [];

for (const manifestPath of findManifests(ROOT).sort()) {
  const dir = dirname(manifestPath);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    rows.push({
      name: dir.replace(ROOT + '/', '').replace(/\\/g, '/'),
      tier: 'no-studio',
      sduiOk: null,
      sduiErrors: [`BAD_MANIFEST_JSON: ${(e as Error).message}`],
      validateOk: false,
      otherErrors: [],
      hasEngine: false,
      hasBundle: false,
      bundleHashOk: null,
      studioPages: 0,
    });
    continue;
  }

  const name = manifest.name ?? dir.replace(ROOT + '/', '').replace(/\\/g, '/');
  const pages = manifest.studio?.pages ?? [];
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const schemaPages = pages.filter((p: any) => p?.schema);
  const tier: Row['tier'] =
    pages.length === 0 ? 'no-studio' : schemaPages.length > 0 ? 'sdui' : 'bespoke';

  const hasEngineTs = existsSync(join(dir, 'engine/index.ts'));
  const hasEngineJs = existsSync(join(dir, 'engine/index.js'));
  let bundleHashOk: boolean | null = null;
  if (hasEngineTs && hasEngineJs) {
    const bytes = readFileSync(join(dir, 'engine/index.js'));
    const actual = createHash('sha256').update(bytes).digest('hex');
    const declared = manifest.integrity?.engineSha256 ?? '';
    bundleHashOk = !!declared && actual === declared;
  }

  const proc = spawnSync('bun', [CLI, 'extension', 'validate', '--dir', dir, '--first-party'], {
    encoding: 'utf8',
    cwd: join(import.meta.dir, '..'),
  });
  const out = (proc.stdout ?? '') + (proc.stderr ?? '');
  const validateOk = proc.status === 0;

  const sduiErrors = [...out.matchAll(/SDUI_[A-Z_]+[^\n]*/g)].map((m) => m[0].trim());
  const allErrLines = out
    .split('\n')
    .filter((l) => l.includes('error') || l.includes('Error') || /\[31m/.test(l))
    // Strip ANSI color codes. Build the regex from a string so there's no
    // literal control character in a regex literal (biome noControlCharactersInRegex).
    .map((l) => l.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '').trim())
    .filter((l) => l && !l.startsWith('SDUI schemas:'));

  const otherErrors = allErrLines.filter(
    (l) => !l.startsWith('SDUI_') && !l.includes('SDUI schemas'),
  );

  rows.push({
    name,
    tier,
    sduiOk: tier === 'sdui' ? sduiErrors.length === 0 : null,
    sduiErrors,
    validateOk,
    otherErrors: validateOk ? [] : otherErrors.slice(0, 3),
    hasEngine: hasEngineTs || hasEngineJs,
    hasBundle: hasEngineJs,
    bundleHashOk,
    studioPages: pages.length,
  });
}

// Summary
const sdui = rows.filter((r) => r.tier === 'sdui');
const bespoke = rows.filter((r) => r.tier === 'bespoke');
const noStudio = rows.filter((r) => r.tier === 'no-studio');
const sduiFail = sdui.filter((r) => !r.sduiOk);
const validateFail = rows.filter((r) => !r.validateOk);
const hashFail = rows.filter((r) => r.bundleHashOk === false);

console.log('\n=== EXTENSION VALIDATION REPORT ===');
console.log(`Root: ${ROOT}`);
console.log(`Total: ${rows.length}`);
console.log(
  `  SDUI (declarative): ${sdui.length} (${sdui.length - sduiFail.length} OK, ${sduiFail.length} FAIL)`,
);
console.log(`  Bespoke (+page.svelte): ${bespoke.length}`);
console.log(`  No studio pages: ${noStudio.length}`);
console.log(`  validate --first-party OK: ${rows.length - validateFail.length}/${rows.length}`);
console.log(`  bundle hash drift: ${hashFail.length}`);

if (sduiFail.length) {
  console.log('\n--- SDUI FAILURES ---');
  for (const r of sduiFail) {
    console.log(`  ${r.name}`);
    for (const e of r.sduiErrors) console.log(`    ${e}`);
  }
}

if (hashFail.length) {
  console.log('\n--- BUNDLE HASH DRIFT ---');
  for (const r of hashFail) console.log(`  ${r.name}`);
}

if (validateFail.length) {
  console.log('\n--- VALIDATE FAILURES (non-SDUI) ---');
  for (const r of validateFail) {
    if (r.tier === 'sdui' && r.sduiErrors.length > 0) continue; // already listed
    console.log(`  ${r.name} [${r.tier}]`);
    for (const e of r.otherErrors) console.log(`    ${e}`);
  }
}

console.log('\n--- PER EXTENSION ---');
console.log('name\ttier\tsdui\tvalidate\tbundle_hash\tpages');
for (const r of rows) {
  console.log(
    `${r.name}\t${r.tier}\t${r.sduiOk === null ? '-' : r.sduiOk ? 'OK' : 'FAIL'}\t${r.validateOk ? 'OK' : 'FAIL'}\t${r.bundleHashOk === null ? '-' : r.bundleHashOk ? 'OK' : 'DRIFT'}\t${r.studioPages}`,
  );
}

process.exit(sduiFail.length + hashFail.length + validateFail.length > 0 ? 1 : 0);
