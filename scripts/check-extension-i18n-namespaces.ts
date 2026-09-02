#!/usr/bin/env bun
/**
 * Gate: an extension's message keys are its own, and it says which they are.
 *
 * WHY THIS EXISTS NOW
 *
 * Catalogues travel to the host: `GET /api/extensions?messages=<locale>`
 * attaches each extension's own `studio/messages/<locale>.json` to its entry,
 * so a host that cannot compile them at build time (anything not our Studio)
 * can still resolve the labels in an SDUI page schema. The host merges the
 * per-extension catalogues, and a merge is last-one-wins.
 *
 * That makes disjointness a correctness property rather than a tidiness one.
 * It holds today — 0 collisions across 56 catalogues and 2309 keys — but it
 * holds by discipline, and discipline is not a mechanism. Two extensions that
 * both ship `finance.total` would render differently depending on load order,
 * on the host, where nobody would think to look.
 *
 * WHAT `i18nPrefixes` IS, AND WHY IT IS A LIST
 *
 * The namespaces an extension owns, DECLARED in its manifest. Never derived
 * from the directory path: that rule was written on 2026-08-10 and reverted
 * before commit because it would have flagged 106 correct keys at
 * `finance/invoicing`, which owns `invoicing.*` — path and namespace do not
 * correspond.
 *
 * Nor is it a single exclusive top-level prefix, which was the other obvious
 * shape and is equally wrong: `finance.*` is written by six extensions and
 * `content.*` by six more. A prefix is claimed at whatever depth the extension
 * actually uses, and 13 of 56 need two.
 *
 * WHAT IS CHECKED
 *   DECLARED   — an extension shipping a catalogue declares i18nPrefixes.
 *   OVERLAP    — no two extensions declare prefixes that contain one another.
 *   UNCLAIMED  — every key an extension ships falls under one of its prefixes.
 *   SQUATTING  — no extension ships a key from the shared vocabulary
 *                (`common.*` / `ext.*`). Those belong to the host; the merge
 *                layers extensions AFTER core, so a squatted key silently
 *                replaces the host's own word everywhere it appears.
 *
 * WHAT IS NOT CHECKED
 *   Whether a key is USED, whether its text is translated in all nine locales,
 *   and whether an SDUI schema references a key that exists — the last is
 *   `zveltio extension validate` (SDUI_I18N_KEY_MISSING), which runs in the
 *   extension's own repository where the schema and the catalogue sit together.
 *
 * Run: bun scripts/check-extension-i18n.ts [extensionsDir]
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_MESSAGE_KEYS } from '../packages/sdk/src/validate/shared-message-keys.js';

/**
 * The sibling checkout, overridable by argv.
 *
 * Sibling-scanning gates in this repository hardcode `../zveltio-extensions`
 * and ignore argv, which makes them unrunnable from a worktree. This one takes
 * the argument.
 */
const EXPLICIT_DIR = process.argv[2];
const EXT_DIR = EXPLICIT_DIR ?? join(import.meta.dir, '../../zveltio-extensions');

interface Problem {
  kind: 'DECLARED' | 'OVERLAP' | 'UNCLAIMED' | 'SQUATTING';
  ext: string;
  detail: string;
}

function findExtensions(base: string, prefix = ''): string[] {
  const out: string[] = [];
  if (!existsSync(base)) return out;
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

/** Every key the extension ships, unioned across the locales it translates. */
async function shippedKeys(ext: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const dir = join(EXT_DIR, ext, 'studio', 'messages');
  if (!existsSync(dir)) return keys;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const cat = JSON.parse(await Bun.file(join(dir, file)).text()) as Record<string, unknown>;
      for (const k of Object.keys(cat)) if (k !== '$schema') keys.add(k);
    } catch {
      // Malformed catalogue: `extension validate` reports it with a better
      // message than this gate could, and failing here would hide that one.
    }
  }
  return keys;
}

function covers(prefix: string, key: string): boolean {
  return key === prefix || key.startsWith(`${prefix}.`);
}

if (!existsSync(EXT_DIR)) {
  // A path given on the command line is a claim that it is there. CI passes
  // one, so a missing directory means the clone step broke — and a gate that
  // shrugs at that is the failure mode this job's own comment records:
  // `ext:i18n-ownership` and `check:raw-sql` printed "skipping" on every run
  // for weeks, and a skipped gate looks exactly like a passing one.
  if (EXPLICIT_DIR !== undefined) {
    console.error(
      `[ext:i18n-ns] extensions checkout not found at ${EXT_DIR} (given as an argument).`,
    );
    process.exit(1);
  }
  console.log(`[ext:i18n-ns] No extensions checkout at ${EXT_DIR} — skipping (no path given).`);
  process.exit(0);
}

const problems: Problem[] = [];
const extensions = findExtensions(EXT_DIR);
const declared = new Map<string, string[]>();

for (const ext of extensions) {
  const keys = await shippedKeys(ext);
  if (keys.size === 0) continue;

  const manifest = JSON.parse(await Bun.file(join(EXT_DIR, ext, 'manifest.json')).text()) as {
    i18nPrefixes?: unknown;
  };
  const prefixes = Array.isArray(manifest.i18nPrefixes) ? (manifest.i18nPrefixes as string[]) : [];
  declared.set(ext, prefixes);

  if (prefixes.length === 0) {
    problems.push({
      kind: 'DECLARED',
      ext,
      detail:
        `ships ${keys.size} message key${keys.size === 1 ? '' : 's'} but declares no ` +
        `"i18nPrefixes". Add the ` +
        `namespaces it owns, e.g. ["${[...keys][0]?.split('.')[0] ?? 'yourext'}"].`,
    });
    continue;
  }

  for (const key of keys) {
    if (SHARED_MESSAGE_KEYS.has(key)) {
      problems.push({
        kind: 'SQUATTING',
        ext,
        detail: `ships "${key}", which belongs to the host's shared vocabulary. Extensions are layered over core in the merge, so this replaces the host's word wherever it appears.`,
      });
      continue;
    }
    if (!prefixes.some((p) => covers(p, key))) {
      problems.push({
        kind: 'UNCLAIMED',
        ext,
        detail: `ships "${key}", outside its declared prefixes [${prefixes.join(', ')}].`,
      });
    }
  }
}

const entries = [...declared.entries()];
for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const [extA, prefA] = entries[i] as [string, string[]];
    const [extB, prefB] = entries[j] as [string, string[]];
    for (const a of prefA) {
      for (const b of prefB) {
        if (a === b || covers(a, b) || covers(b, a)) {
          problems.push({
            kind: 'OVERLAP',
            ext: extA,
            detail: `claims "${a}", which overlaps "${b}" claimed by ${extB}. On a host that merges catalogues, whichever loads last wins.`,
          });
        }
      }
    }
  }
}

if (problems.length === 0) {
  console.log(
    `[ext:i18n-ns] ${declared.size} extensions, ${[...declared.values()].flat().length} declared ` +
      'namespaces, no collisions.',
  );
  process.exit(0);
}

const byKind = new Map<string, Problem[]>();
for (const p of problems) {
  const list = byKind.get(p.kind) ?? [];
  list.push(p);
  byKind.set(p.kind, list);
}
for (const [kind, list] of byKind) {
  console.error(`\n${kind} (${list.length})`);
  // A squatted or unclaimed key repeats per locale-union entry; show enough to
  // act on without printing a catalogue.
  for (const p of list.slice(0, 20)) console.error(`  ${p.ext}: ${p.detail}`);
  if (list.length > 20) console.error(`  … and ${list.length - 20} more`);
}
console.error(`\n[ext:i18n-ns] ${problems.length} problem(s).`);
process.exit(1);
