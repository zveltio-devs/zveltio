#!/usr/bin/env bun
/**
 * Every gate CI runs is either proved by planting, or listed with a reason.
 *
 * `audit-gates.ts` answers "would this gate CATCH the thing it names?" by
 * planting the violation and checking the gate goes red. It is the only honest
 * evidence a gate is not decoration — and the repository has paid twice for the
 * difference: `check-numeric-string-arithmetic` exited 0 in four distinct ways
 * that all read as "clean", and `scripts/dr-drill.sh` backed a P0 for two
 * months while aborting on its first command.
 *
 * What it could not answer is how much it covers. When this gate was written,
 * the maturity plan recorded "100% coverage, 11/11 today" — and 11 was the
 * number of CASES, which target 9 gate files out of the 31 CI runs. Twenty-two
 * gates were running unproven, and nothing said so.
 *
 * So this is the ratchet: a NEW gate cannot join CI without either a planted
 * case or a written reason. The twenty-two already there are recorded in
 * `quality-gates/gate-coverage.json` with a reason each, and that list may
 * shrink, never grow.
 *
 * WHAT COUNTS AS A GATE — allowlist, not denylist. Any `scripts/*.ts` that a
 * workflow invokes is a gate until `not_a_gate` says otherwise, with a reason.
 * The inverse (a list of known gate names) is what lets the next one slip
 * through under a name nobody thought of: `check-pooldb-txn-skip` sat outside
 * CI entirely because it lived only in `prepush`, and `prepush` is wired to no
 * git hook at all.
 *
 * Fail-closed everywhere. No workflows found, no cases parsed, baseline
 * missing — all exit non-zero. A gate that cannot check must not report OK;
 * that is the exact shape this block exists to remove.
 *
 * Usage:
 *   bun run scripts/check-gate-coverage.ts
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BASELINE = join(ROOT, 'quality-gates', 'gate-coverage.json');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const AUDIT = join(ROOT, 'scripts', 'audit-gates.ts');

function die(msg: string): never {
  console.error(`[gate-coverage] FAIL — ${msg}`);
  process.exit(1);
}

// ── Inputs, each checked rather than assumed ────────────────────────────────
if (!existsSync(BASELINE)) die(`baseline missing: ${BASELINE}`);
if (!existsSync(AUDIT)) die(`meta-gate missing: ${AUDIT}`);
if (!existsSync(WORKFLOWS)) die(`no workflows directory: ${WORKFLOWS}`);

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
  not_a_gate: Record<string, string>;
  uncovered: Record<string, string>;
};
if (!baseline.not_a_gate || !baseline.uncovered) die('baseline is missing a required section');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const SCRIPT_RE = /scripts\/[a-z0-9-]+\.ts/g;

/** A `bun run X` where X is either a script path or a package.json script name. */
function resolve(invocation: string): string[] {
  if (invocation.startsWith('scripts/')) return [invocation];
  const body = pkg.scripts[invocation];
  return body ? (body.match(SCRIPT_RE) ?? []) : [];
}

// ── What CI actually runs ──────────────────────────────────────────────────
const workflowFiles = readdirSync(WORKFLOWS).filter(
  (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
);
if (workflowFiles.length === 0) die('no workflow files — cannot tell what CI runs');

const ciScripts = new Set<string>();
for (const f of workflowFiles) {
  // Line by line, skipping comments. A workflow comment that mentions a command
  // — "this used to run bun run scripts/foo.ts" — is prose about the past, and
  // counting it would put a script CI does not run onto the list somebody then
  // has to write a reason for. Found while planting the violation for this very
  // gate, which is the argument for planting rather than reading.
  for (const line of readFileSync(join(WORKFLOWS, f), 'utf8').split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    for (const m of line.matchAll(/bun run ([a-z0-9:.\-/]+(?:\.ts)?)/g)) {
      for (const s of resolve(m[1]!)) ciScripts.add(s);
    }
  }
}
if (ciScripts.size === 0)
  die('parsed the workflows and found no scripts — the pattern stopped matching');

// ── What the meta-gate proves ──────────────────────────────────────────────
const auditSrc = readFileSync(AUDIT, 'utf8');
const covered = new Set<string>();
// A case may exercise a gate through a wrapper — seeding a row, or removing a
// call and restoring it. The command then names the wrapper, not the gate, so
// the case declares the gate in `proves` and it is read here. Declared, not
// inferred: a checker that guessed at indirection would credit any wrapper.
for (const m of auditSrc.matchAll(/proves: \[([^\]]+)\]/g)) {
  for (const s of m[1]!.match(SCRIPT_RE) ?? []) covered.add(s);
}

// Backtick commands too. A case written as a template literal was invisible
// here and read as "no case at all" — the checker said a proven gate was
// unproven, which is the failure mode that wastes the most time.
for (const m of auditSrc.matchAll(/cmd: `([^`]+)`/g)) {
  for (const s of m[1]!.match(SCRIPT_RE) ?? []) covered.add(s);
  for (const r of m[1]!.matchAll(/bun run ([a-z0-9:.-]+)/g)) covered.add(r[1]!);
}

for (const m of auditSrc.matchAll(/cmd: '([^']+)'/g)) {
  for (const s of m[1]!.match(SCRIPT_RE) ?? []) covered.add(s);
  for (const r of m[1]!.matchAll(/bun run ([a-z0-9:.-]+)/g)) {
    for (const s of resolve(r[1]!)) covered.add(s);
  }
}
if (covered.size === 0)
  die('audit-gates.ts yielded no cases — the parse broke, or every case is gone');

// ── The three ways this can fail ───────────────────────────────────────────
const problems: string[] = [];

// 1. A gate CI runs that is neither proved nor excused. This is the new-gate case.
for (const s of [...ciScripts].sort()) {
  if (covered.has(s)) continue;
  if (s in baseline.not_a_gate) continue;
  if (s in baseline.uncovered) continue;
  problems.push(
    `  ${s}\n` +
      `      runs in CI, has no case in audit-gates.ts, and is in neither baseline section.\n` +
      `      Add a case that plants its violation — or, if it cannot have one, an entry in\n` +
      `      "uncovered" saying why. "not_a_gate" is for scripts that cannot fail a build.`,
  );
}

// 2. The ratchet tightening: a baseline entry that is now proved must leave the list,
//    or the number stops meaning anything and the next reader trusts a stale count.
for (const s of Object.keys(baseline.uncovered).sort()) {
  if (covered.has(s)) {
    problems.push(
      `  ${s}\n      now HAS a planted case — remove it from "uncovered" in the baseline.`,
    );
  }
}

// 3. A baseline entry naming a script that no longer exists. Left alone it is a
//    permanent excuse for nothing, and it hides the entry that replaced it.
for (const section of ['not_a_gate', 'uncovered'] as const) {
  for (const s of Object.keys(baseline[section]).sort()) {
    if (!existsSync(join(ROOT, s))) {
      problems.push(
        `  ${s}\n      listed in "${section}" but the file is gone — remove the entry.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('[gate-coverage] FAIL —');
  for (const p of problems) console.error(p);
  process.exit(1);
}

const proven = [...ciScripts].filter((s) => covered.has(s)).length;
const excused = [...ciScripts].filter((s) => s in baseline.uncovered).length;
console.log(
  `[gate-coverage] OK — ${ciScripts.size} scripts run in CI: ` +
    `${proven} proved by planting, ${excused} recorded as unproven with a reason, ` +
    `${Object.keys(baseline.not_a_gate).length} declared not gates.`,
);
