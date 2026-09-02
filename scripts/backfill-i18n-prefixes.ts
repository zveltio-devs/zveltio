#!/usr/bin/env bun
/**
 * ONE-SHOT: write `i18nPrefixes` into every extension manifest that ships a
 * message catalogue.
 *
 * The field is declared, never derived — deriving it from the directory path
 * was tried on 2026-08-10 and reverted, because `finance/invoicing` owns
 * `invoicing.*` and the two do not correspond. This script does not derive it
 * either: it reads the keys each extension ACTUALLY ships and computes the
 * shortest namespaces that cover them without claiming a key belonging to
 * somebody else. What it writes is therefore a description of today's truth,
 * which a human can then correct — not a rule imposed on the catalogues.
 *
 * Keys under the shared vocabulary (`common.*`) are excluded: they belong to
 * the host, and no extension may claim them.
 *
 * Run once, review the diff, delete. The gate (`check-extension-i18n-namespaces.ts`) is
 * what keeps the field true afterwards.
 *
 * Usage: bun scripts/backfill-i18n-prefixes.ts [extensionsDir] [--write]
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EXT_DIR =
  process.argv.find((a) => !a.startsWith('--') && a.endsWith('zveltio-extensions')) ??
  join(import.meta.dir, '../../zveltio-extensions');
const WRITE = process.argv.includes('--write');
const SHARED_PREFIX = 'common.';

/** Every directory holding a manifest.json, at any nesting depth. */
function findExtensions(base: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (existsSync(join(base, entry.name, 'manifest.json'))) out.push(rel);
    else out.push(...findExtensions(join(base, entry.name), rel));
  }
  return out;
}

async function readKeys(extPath: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const dir = join(EXT_DIR, extPath, 'studio', 'messages');
  if (!existsSync(dir)) return keys;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const cat = JSON.parse(await Bun.file(join(dir, file)).text()) as Record<string, unknown>;
      for (const k of Object.keys(cat)) {
        if (k !== '$schema' && !k.startsWith(SHARED_PREFIX)) keys.add(k);
      }
    } catch {
      // A malformed catalogue is the extension's problem; the gate reports it.
    }
  }
  return keys;
}

/**
 * Shortest prefixes covering `own` without covering any key another extension
 * ships. Walking segment by segment from the left means `finance/invoicing`
 * gets `finance.invoice` rather than `finance` — the latter would swallow five
 * sibling extensions' keys.
 */
function minimalPrefixes(own: Set<string>, foreign: Set<string>): string[] {
  const out: string[] = [];
  for (const key of [...own].sort()) {
    if (out.some((p) => key === p || key.startsWith(`${p}.`))) continue;
    const parts = key.split('.');
    let claimed = key;
    for (let depth = 1; depth <= parts.length; depth++) {
      const cand = parts.slice(0, depth).join('.');
      let steals = false;
      for (const other of foreign) {
        if (other === cand || other.startsWith(`${cand}.`)) {
          steals = true;
          break;
        }
      }
      if (!steals) {
        claimed = cand;
        break;
      }
    }
    out.push(claimed);
  }
  return [...new Set(out)].sort();
}

const extensions = findExtensions(EXT_DIR);
const keysByExt = new Map<string, Set<string>>();
for (const ext of extensions) keysByExt.set(ext, await readKeys(ext));

let written = 0;
for (const ext of extensions) {
  const own = keysByExt.get(ext) ?? new Set();
  if (own.size === 0) continue;
  const foreign = new Set<string>();
  for (const [other, keys] of keysByExt) {
    if (other !== ext) for (const k of keys) foreign.add(k);
  }
  const prefixes = minimalPrefixes(own, foreign);

  const manifestPath = join(EXT_DIR, ext, 'manifest.json');
  const raw = await Bun.file(manifestPath).text();
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  if (JSON.stringify(manifest.i18nPrefixes) === JSON.stringify(prefixes)) continue;

  // Insert after `permissions` when present so related declarations sit
  // together, else before `studio`, else at the end.
  const entries = Object.entries(manifest).filter(([k]) => k !== 'i18nPrefixes');
  const at = entries.findIndex(([k]) => k === 'permissions');
  const before = entries.findIndex(([k]) => k === 'studio');
  const idx = at >= 0 ? at + 1 : before >= 0 ? before : entries.length;
  entries.splice(idx, 0, ['i18nPrefixes', prefixes]);

  console.log(`${ext.padEnd(34)} ${prefixes.join(', ')}`);
  if (WRITE) {
    await Bun.write(manifestPath, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
    written++;
  }
}

console.log(`\n${WRITE ? `${written} manifests written` : 'dry run — pass --write to apply'}`);
