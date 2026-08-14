#!/usr/bin/env bun
/**
 * Every message key an extension's Studio page renders must belong to that
 * extension, to a declared dependency, or to the host's shared catalogue.
 *
 * Ten extensions render keys namespaced to OTHER extensions —
 * `developer/views` renders `developer.validation.ui.config_json`,
 * `projects/management` renders `communications.mail.*`, and so on. They work
 * today only because the host serves the UNION of every installed extension's
 * catalogue, so a borrowed key resolves as long as its owner happens to be
 * installed. Extensions are independently installable: install the borrower
 * without the owner and the label renders as a raw key.
 *
 * `extension-validate` already performs this check for SDUI schemas, using the
 * same three sources. It does not look at `.svelte` pages, which is where all
 * ten of these live.
 *
 * Usage:
 *   bun run scripts/check-extension-i18n-ownership.ts [extensionsDir]
 *   bun run scripts/check-extension-i18n-ownership.ts --update   # re-baseline
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const EXT_DIR =
  process.argv.find((a) => !a.startsWith('-') && a.includes('extensions')) ??
  join(ROOT, '..', 'zveltio-extensions');
const BASELINE = join(ROOT, 'quality-gates', 'extension-i18n-baseline.json');

/** Keys the host ships for every extension — navigation, buttons, common words. */
function hostKeys(): Set<string> {
  const path = join(ROOT, 'packages', 'studio', 'messages', 'core', 'en.json');
  if (!existsSync(path)) return new Set();
  return new Set(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object));
}

function ownKeys(extDir: string): Set<string> {
  const path = join(extDir, 'studio', 'messages', 'en.json');
  if (!existsSync(path)) return new Set();
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object));
  } catch {
    return new Set();
  }
}

/** Extension directories: `<category>/<name>` or a bare `<name>`. */
function extensionDirs(): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = [];
  for (const top of readdirSync(EXT_DIR)) {
    if (top.startsWith('.') || top === 'node_modules' || top === 'scripts' || top === 'testing')
      continue;
    const topPath = join(EXT_DIR, top);
    if (!statSync(topPath).isDirectory()) continue;
    if (existsSync(join(topPath, 'manifest.json'))) {
      out.push({ name: top, dir: topPath });
      continue;
    }
    for (const sub of readdirSync(topPath)) {
      const subPath = join(topPath, sub);
      if (statSync(subPath).isDirectory() && existsSync(join(subPath, 'manifest.json'))) {
        out.push({ name: `${top}/${sub}`, dir: subPath });
      }
    }
  }
  return out;
}

function svelteFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.svelte')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Declared dependencies, whose namespaces are legitimate to render. */
function declaredDeps(extDir: string): string[] {
  try {
    const m = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8')) as {
      dependencies?: string[] | Record<string, unknown>;
    };
    const d = m.dependencies;
    return Array.isArray(d) ? d : d ? Object.keys(d) : [];
  } catch {
    return [];
  }
}

const host = hostKeys();
const exts = extensionDirs();
const byName = new Map(exts.map((e) => [e.name, e.dir]));

/** borrower → sorted list of foreign keys it renders */
const violations: Record<string, string[]> = {};

for (const { name, dir } of exts) {
  const own = ownKeys(dir);
  if (own.size === 0) continue; // no catalogue — extension-validate's concern

  const allowed = new Set([...own, ...host]);
  for (const dep of declaredDeps(name === dir ? name : name)) {
    const depDir = byName.get(dep);
    if (depDir) for (const k of ownKeys(depDir)) allowed.add(k);
  }

  const foreign = new Set<string>();
  for (const file of svelteFiles(join(dir, 'studio'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bm\[['"]([^'"]+)['"]\]/g)) {
      const key = m[1]!;
      if (!allowed.has(key)) foreign.add(key);
    }
  }
  if (foreign.size > 0) violations[name] = [...foreign].sort();
}

if (process.argv.includes('--update')) {
  // Written through biome's formatter afterwards: `JSON.stringify` expands short
  // arrays over multiple lines and biome collapses them, so `--update` would
  // otherwise leave the repo failing `format:check` every time it ran.
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        generated: new Date().toISOString().slice(0, 10),
        note:
          'Extensions rendering message keys they do not own. These resolve only because the ' +
          'host serves the union of installed catalogues — install the borrower without the ' +
          'owner and the label renders as a raw key. The list may shrink, never grow.',
        violations,
      },
      null,
      2,
    )}\n`,
  );
  Bun.spawnSync(['bun', 'x', 'biome', 'format', '--write', BASELINE], { cwd: ROOT });
  const n = Object.values(violations).reduce((a, b) => a + b.length, 0);
  console.log(
    `[ext-i18n] baseline written — ${n} borrowed keys across ${Object.keys(violations).length} extensions.`,
  );
  process.exit(0);
}

let baseline: { violations: Record<string, string[]> };
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
} catch {
  console.error(`[ext-i18n] no baseline at ${BASELINE}. Run with --update to create one.`);
  process.exit(1);
}

const isNew: string[] = [];
const fixed: string[] = [];
for (const [ext, keys] of Object.entries(violations)) {
  const known = new Set(baseline.violations[ext] ?? []);
  for (const k of keys) if (!known.has(k)) isNew.push(`  ${ext} renders ${k}`);
}
for (const [ext, keys] of Object.entries(baseline.violations)) {
  const now = new Set(violations[ext] ?? []);
  for (const k of keys) if (!now.has(k)) fixed.push(`  ${ext} no longer renders ${k}`);
}

if (fixed.length > 0) {
  console.log('[ext-i18n] improvements:');
  for (const l of fixed) console.log(l);
  console.log('Run with --update to lock them in.');
}

if (isNew.length > 0) {
  console.error('[ext-i18n] FAIL — an extension renders a key it does not own:');
  for (const l of isNew) console.error(l);
  console.error(
    "\nAdd the key to this extension's own catalogue (all locales), or declare a dependency\n" +
      'on the extension that owns it. It resolves today only because the owner happens to be\n' +
      'installed alongside.',
  );
  process.exit(1);
}

const total = Object.values(violations).reduce((a, b) => a + b.length, 0);
console.log(`[ext-i18n] OK — ${total} known borrowed keys, none new.`);
