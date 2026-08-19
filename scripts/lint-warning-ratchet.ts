#!/usr/bin/env bun
/**
 * Lint-warning ratchet.
 *
 * `bun run lint` exits 0 with 85 warnings and 23 infos. Warnings never fail the
 * build, so the count drifts upward one commit at a time and nobody is ever the
 * person who broke it. Biome also truncates its output by default, so the list
 * is not even fully visible in a normal run — the number is the only thing a
 * reader gets, and nothing was watching it.
 *
 * Same shape as `any-ratchet.ts`, and for the same reason: a count that can only
 * go down turns a growing pile into a shrinking one without demanding it be
 * emptied today.
 *
 *   - count went UP in any rule    → fail (a new warning was introduced)
 *   - count went DOWN              → pass, and nudge to lower the baseline
 *   - unchanged                    → pass
 *
 * Per rule rather than one total, because a single number lets a fix in one
 * place pay for a regression in another — and the two are rarely related.
 *
 * Usage:
 *   bun run scripts/lint-warning-ratchet.ts            # check against baseline (CI)
 *   bun run scripts/lint-warning-ratchet.ts --update   # regenerate after a drop
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BASELINE = join(ROOT, 'quality-gates', 'lint-warning-baseline.json');

interface Baseline {
  generated: string;
  note: string;
  /** rule name → warning count */
  rules: Record<string, number>;
}

/**
 * Count warnings per rule from biome's summary reporter.
 *
 * Lines look like:  `  suppressions/unused    44 (44 warnings)`
 * Infos are reported the same way and are deliberately NOT counted: they are
 * advisory, and folding them in would make the gate fire on changes nobody
 * asked for.
 */
async function countWarnings(): Promise<Record<string, number>> {
  const proc = Bun.spawn(['bun', 'x', 'biome', 'lint', '--reporter=summary'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  await proc.exited;

  const rules: Record<string, number> = {};
  for (const line of out.split('\n')) {
    const m = /^\s*(\S+)\s+(\d+)\s+\((\d+)\s+warnings?\)/.exec(line);
    if (m) rules[m[1]!] = Number(m[3]);
  }
  return rules;
}

const rules = await countWarnings();
const total = Object.values(rules).reduce((a, b) => a + b, 0);

if (Object.keys(rules).length === 0) {
  // Biome changing its summary format would otherwise read as "zero warnings,
  // everything improved" and quietly disable this gate.
  console.error('[lint-ratchet] parsed no rules from biome output — the format changed.');
  process.exit(1);
}

if (process.argv.includes('--update')) {
  const next: Baseline = {
    generated: new Date().toISOString().slice(0, 10),
    note:
      'Per-rule biome warning counts. A rule may not exceed its baseline. ' +
      'Lower the numbers when you fix warnings; never raise them to make CI pass.',
    rules,
  };
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `[lint-ratchet] baseline written — ${total} warnings across ${Object.keys(rules).length} rules.`,
  );
  process.exit(0);
}

let baseline: Baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
} catch {
  console.error(`[lint-ratchet] no baseline at ${BASELINE}. Run with --update to create one.`);
  process.exit(1);
}

const regressions: string[] = [];
const improvements: string[] = [];
for (const [rule, count] of Object.entries(rules)) {
  const was = baseline.rules[rule] ?? 0;
  if (count > was) regressions.push(`  ${rule}: ${was} → ${count}  (+${count - was})`);
  else if (count < was) improvements.push(`  ${rule}: ${was} → ${count}  (-${was - count})`);
}
// A rule that vanished entirely is an improvement worth reporting.
for (const [rule, was] of Object.entries(baseline.rules)) {
  if (!(rule in rules) && was > 0) improvements.push(`  ${rule}: ${was} → 0  (-${was})`);
}

if (improvements.length > 0) {
  console.log('[lint-ratchet] improvements:');
  for (const line of improvements) console.log(line);
}

if (regressions.length > 0) {
  console.error('[lint-ratchet] FAIL — new lint warnings:');
  for (const line of regressions) console.error(line);
  console.error('\nFix the warning, or explain it in review and run --update.');
  process.exit(1);
}

console.log(`[lint-ratchet] OK — ${total} warnings, none above baseline.`);
