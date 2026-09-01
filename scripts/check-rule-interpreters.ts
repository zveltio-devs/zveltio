#!/usr/bin/env bun
/**
 * A row rule is interpreted in more than one place. Every one of them must be
 * in the differential suite.
 *
 * `zvd_rls_policies` stores four operators — eq, neq, in, not_in — and four
 * value sources. Nothing in the codebase compiles a rule once: each consumer
 * branches on the operator itself and emits its own form.
 *
 *   applyRlsFilters       a Kysely WHERE, on the live table
 *   buildRowRulePredicate SQL text, as a Postgres RESTRICTIVE policy
 *   matchesRlsFilters     JavaScript, in-process, for realtime fan-out
 *   rlsJsonConditions     SQL over the jsonb snapshots, for `?as_of=`
 *
 * ── Why this exists ───────────────────────────────────────────
 *
 * An independent audit found SEVEN divergences among the first three. The real
 * one was `neq` against a NULL column: absent from `/api/data`, delivered over
 * SSE. A leak, produced by nothing more than two functions disagreeing about
 * what one stored rule means.
 *
 * Those three were corrected and pinned by a differential suite. The fourth was
 * not, because nobody had counted it — it lives in the same file as two of the
 * others and its own comment calls itself "the third", having been written
 * before the policy generator existed elsewhere. It kept the pre-audit meaning
 * for a day, which means `?as_of=` — the parameter that exists for auditing —
 * still showed rows `/api/data` withheld. Adding it to the suite turned 56 green
 * cases into 18 failures on unchanged code.
 *
 * So the failure mode is not "someone writes an operator wrong". It is "someone
 * adds a fifth interpreter and nothing compares it to the other four". A comment
 * asking to keep them adjacent did not prevent it; a test that only knows about
 * the appliers someone remembered to add cannot prevent it either.
 *
 * This counts them instead. A new interpreter is a build failure until it is
 * registered here AND covered by the suite.
 *
 * The real fix is one compiler with four backends, so a fifth form cannot be
 * written by hand at all. Until that exists, this is the thing that makes its
 * absence loud.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'packages/engine/src');
const REPORT_ONLY = process.argv.includes('--report');

/**
 * The interpreters we know about, each with the suite case that pins it.
 *
 * Adding a name here is a claim that `row-rules-four-interpreters.test.ts`
 * exercises it over the operator x source x column-type x NULL matrix. The gate
 * checks the suite mentions it; it cannot check the coverage is honest, which is
 * why the claim is written down rather than inferred.
 */
const KNOWN = new Map<string, string>([
  ['applyRlsFilters', 'the live-table WHERE'],
  ['matchesRlsFilters', 'the in-process evaluator'],
  ['rlsJsonConditions', 'SQL over jsonb snapshots (?as_of=)'],
  ['buildRowRulePredicate', 'the generated RESTRICTIVE policy'],
  // Not an emitter, but it decides what the other four are asked. It resolves a
  // stored rule plus an identity into a condition, and in doing so makes a
  // semantic choice the emitters cannot see: `in` and `not_in` comma-split a
  // `static:` value, `eq` does not. Get that wrong and all four agree on the
  // wrong thing, which no comparison between them would catch.
  ['getRlsFilters', 'the resolver: stored rule + identity -> condition'],
  // The validator. It decides which rules are impossible to express, and the
  // suite partitions on it rather than on a hand-written exclusion list —
  // hand-written lists are how the audit's cases slipped past the last one.
  ['describeRuleProblem', 'the validator the suite partitions on'],
]);

/**
 * Branches on the same operator names for a DIFFERENT question.
 *
 * Listed with the reason, not silently filtered: the whole point of this gate is
 * that "it also mentions not_in" is worth a second look, and the answer belongs
 * where the next person will read it.
 */
const NOT_INTERPRETERS = new Map<string, string>([
  [
    'registerCoreFieldTypes',
    'declares which operators each field type OFFERS (filterOperators). A list ' +
      'of names, not a reading of them. Note it advertises is_null/is_not_null, ' +
      'which no rule applier implements — they fail closed, loudly, by design.',
  ],
  [
    'buildCondition',
    'the user-facing `?filter=` query builder in db/dynamic.ts. Same operator ' +
      'names, different feature: a caller-supplied filter narrows what a caller ' +
      'already may see, while a row rule decides what that is. It is a fifth ' +
      'implementation of these four operators and it should probably share the ' +
      'compiler eventually — but it is not a rule interpreter, and folding it in ' +
      'here would make this count mean two things at once.',
  ],
]);

/** The suite that has to mention every one of them. */
const SUITE = join(SRC, 'tests/harness/row-rules-four-interpreters.test.ts');

/**
 * A function that decides something per operator.
 *
 * Matched on the operator literals rather than on a type name: a new applier
 * will not import anything in particular, but it cannot avoid naming the four
 * operators it has to branch on. `not_in` is the discriminating one — it is the
 * only string of the four that occurs nowhere else in this codebase for another
 * reason.
 */
const BRANCHES_ON_OPERATORS = /'not_in'/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name === 'testing') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * `export function NAME` / `export async function NAME` above a match.
 *
 * `matchAll` rather than a `while ((m = re.exec(…)))` loop: the assignment-in-
 * expression form is a lint warning this repo ratchets, and a gate that adds
 * warnings while enforcing a rule is a poor argument for itself.
 */
function enclosingExports(text: string): string[] {
  const names: string[] = [];
  const marks = [...text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map(
    (m) => ({ at: m.index ?? 0, name: m[1]! }),
  );

  for (const o of text.matchAll(/'not_in'/g)) {
    let owner = '';
    for (const mark of marks) if (mark.at < (o.index ?? 0)) owner = mark.name;
    if (owner && !names.includes(owner)) names.push(owner);
  }
  return names;
}

const found = new Map<string, string>();
for (const file of walk(SRC)) {
  const text = Bun.file(file).text ? await Bun.file(file).text() : '';
  if (!BRANCHES_ON_OPERATORS.test(text)) continue;
  for (const name of enclosingExports(text)) found.set(name, file);
}

const suite = await Bun.file(SUITE).text();

const unregistered = [...found].filter(([name]) => !KNOWN.has(name) && !NOT_INTERPRETERS.has(name));
const uncovered = [...KNOWN.keys()].filter((name) => !suite.includes(name));
const vanished = [...KNOWN.keys()].filter((name) => !found.has(name));

if (REPORT_ONLY) {
  console.log(`[rule-interpreters] ${found.size} found, ${KNOWN.size} registered\n`);
  for (const [name, file] of found) {
    const mark = KNOWN.has(name) ? '✓' : NOT_INTERPRETERS.has(name) ? '–' : '?';
    console.log(`  ${mark} ${name.padEnd(24)} ${relative(ROOT, file)}`);
  }
  process.exit(0);
}

if (unregistered.length > 0) {
  console.error(
    `\n❌ ${unregistered.length} function(s) interpret a row rule but are not registered.\n\n` +
      `   Every place that branches on the four operators emits its own reading of\n` +
      `   one stored rule. Seven such divergences were found by an audit and one of\n` +
      `   them was a leak; an eighth survived a day longer because nothing counted\n` +
      `   the applier it lived in.\n`,
  );
  for (const name of unregistered)
    console.error(`  ${name.padEnd(24)} ${relative(ROOT, found.get(name)!)}`);
  console.error(
    `\n  Add each to the differential suite\n` +
      `    ${relative(ROOT, SUITE)}\n` +
      `  so it is compared against the others over the whole matrix, then register it\n` +
      `  in KNOWN in this file. If it does NOT interpret a rule, say why there.\n`,
  );
  process.exit(1);
}

if (uncovered.length > 0) {
  console.error(
    `\n❌ ${uncovered.length} registered interpreter(s) are not named by the differential suite.\n`,
  );
  for (const name of uncovered) console.error(`  ${name}`);
  console.error(`\n  ${relative(ROOT, SUITE)} must exercise each one.\n`);
  process.exit(1);
}

if (vanished.length > 0) {
  console.error(
    `\n❌ ${vanished.length} registered interpreter(s) no longer exist in the source.\n` +
      `   Remove them from KNOWN — a stale entry makes the count meaningless.\n`,
  );
  for (const name of vanished) console.error(`  ${name}`);
  process.exit(1);
}

console.log(
  `[rule-interpreters] OK — ${found.size} interpreters, all registered and all named by ` +
    `${relative(ROOT, SUITE)}`,
);
