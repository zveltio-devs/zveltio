#!/usr/bin/env bun
/**
 * `noExplicitAny` suppression ratchet — docs/HARDENING-9-PLAN.md H-01.
 *
 * `biome.json` sets `noExplicitAny` to `error`, so any NEW bare `any` fails
 * `bun run lint` outright. That alone, though, invites a lazy workaround:
 * silence the error with a fresh `// biome-ignore` comment. This ratchet
 * closes that loophole. It counts the suppression comments per package bucket
 * and compares them to a committed baseline (`refactoring/any-baseline.json`):
 *
 *   - count went UP in any bucket  → fail (someone suppressed a new `any`)
 *   - count went DOWN              → pass, and nudge to lower the baseline
 *   - unchanged                    → pass
 *
 * Net effect: the total legacy-`any` debt can only shrink. Waves H-04..H-06 of
 * the plan drive it down; this guard makes sure it never creeps back up.
 *
 * The file set is the SAME one the codemod suppressed (see `lib/any-targets.ts`)
 * so the ratchet guards exactly what was frozen — no more, no less.
 *
 * Usage:
 *   bun run scripts/any-ratchet.ts            # check against baseline (CI)
 *   bun run scripts/any-ratchet.ts --update   # regenerate baseline after a drop
 *   bun run scripts/any-ratchet.ts --verify   # assert the rule is still `error`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bucketOf, enumerateTargets } from './lib/any-targets.ts';

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'refactoring', 'any-baseline.json');
const MARKER = /biome-ignore\s+lint\/suspicious\/noExplicitAny/g;

type Baseline = {
  generated: string;
  note: string;
  total: number;
  counts: Record<string, number>;
};

/** Count suppression markers per bucket across the enforced file set. */
function tally(): { counts: Record<string, number>; total: number } {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const path of enumerateTargets(ROOT)) {
    let content: string;
    try {
      content = readFileSync(join(ROOT, path), 'utf8');
    } catch {
      continue; // deleted-but-tracked edge case; skip
    }
    const n = content.match(MARKER)?.length ?? 0;
    if (n === 0) continue;
    const b = bucketOf(path);
    counts[b] = (counts[b] ?? 0) + n;
    total += n;
  }
  return { counts, total };
}

/** Guard against silently reverting the rule to `off`, which would gut H-01. */
function verifyRuleEnforced(): boolean {
  const biome = JSON.parse(readFileSync(join(ROOT, 'biome.json'), 'utf8'));
  const sev = biome?.linter?.rules?.suspicious?.noExplicitAny;
  if (sev !== 'error') {
    console.error(
      `[any-ratchet] biome.json linter.rules.suspicious.noExplicitAny is "${sev}", expected "error". ` +
        'Re-enabling this rule is the whole point of H-01 — do not turn it off.',
    );
    return false;
  }
  console.log('[any-ratchet] rule severity OK (error).');
  return true;
}

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function writeBaseline(counts: Record<string, number>, total: number): void {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  const baseline: Baseline = {
    generated: new Date().toISOString().slice(0, 10),
    note: 'Per-bucket noExplicitAny suppression counts. Ratchet: counts may only decrease. See docs/HARDENING-9-PLAN.md H-01.',
    total,
    counts: sorted,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`[any-ratchet] baseline written: total=${total}`);
}

const arg = process.argv[2];

if (arg === '--verify') {
  process.exit(verifyRuleEnforced() ? 0 : 1);
}

const { counts, total } = tally();

if (arg === '--update') {
  writeBaseline(counts, total);
  process.exit(0);
}

// Default: check mode.
if (!verifyRuleEnforced()) process.exit(1);

const baseline = loadBaseline();
const buckets = new Set([...Object.keys(baseline.counts), ...Object.keys(counts)]);
const regressions: string[] = [];
const improvements: string[] = [];

for (const b of [...buckets].sort()) {
  const was = baseline.counts[b] ?? 0;
  const now = counts[b] ?? 0;
  if (now > was) regressions.push(`  ${b}: ${was} → ${now}  (+${now - was})`);
  else if (now < was) improvements.push(`  ${b}: ${was} → ${now}  (-${was - now})`);
}

if (improvements.length > 0) {
  console.log('[any-ratchet] improvements:');
  for (const l of improvements) console.log(l);
}

if (regressions.length > 0) {
  console.error('[any-ratchet] FAIL — new `any` suppressions introduced:');
  for (const l of regressions) console.error(l);
  console.error(
    '\nType the value instead of adding a suppression. If a suppression is truly ' +
      'unavoidable, that is a design smell worth discussing in review — not a routine bypass.',
  );
  process.exit(1);
}

if (improvements.length > 0) {
  console.log(
    `\n[any-ratchet] debt decreased (total ${baseline.total} → ${total}). ` +
      'Run `bun run scripts/any-ratchet.ts --update` and commit the new baseline.',
  );
}

console.log(`[any-ratchet] OK — total suppressions ${total} (baseline ${baseline.total}).`);
