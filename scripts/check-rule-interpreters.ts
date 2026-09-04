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
 * The file every reading of the four operators must come from.
 *
 * `rule-operators.ts` holds the decisions: the SQL spelling, the Kysely
 * spelling, the in-memory predicate, and the rule that a missing value drops the
 * row on every operator. The four appliers render it; they no longer decide
 * anything themselves.
 */
const SOURCE = 'rule-operators.js';

/** An `import … from '…/rule-operators.js'`, in either the static or the
 *  dynamic form — as opposed to the file merely naming it in prose. */
const IMPORTS_SOURCE = /(?:from|import\s*\(\s*)\s*['"][^'"]*rule-operators\.js['"]/;

/** The suite that compares the four renderings over the whole matrix. */
const SUITE = join(SRC, 'tests/harness/row-rules-four-interpreters.test.ts');

/** The structural half: proof that each applier really reads the table. */
const SINGLE_SOURCE_SUITE = join(SRC, 'tests/unit/rule-operators-single-source.test.ts');

/**
 * Files that name the operators for a DIFFERENT question, listed with the reason
 * rather than filtered silently — "it also mentions not_in" is worth a second
 * look, and the answer belongs where the next person will read it.
 */
const NOT_RULE_READERS = new Map<string, string>([
  [
    'field-types/index.ts',
    'declares which operators each field type OFFERS. A list of names, not a ' +
      'reading of them. It advertises is_null/is_not_null, which no rule applier ' +
      'implements — those fail closed, loudly, by design.',
  ],
  ['lib/data/field-type-registry.ts', 'the same declaration, on the registry side.'],
  [
    'db/dynamic.ts',
    'the `?filter=` query builder — and, on the LIST path only, the thing that ' +
      'actually applies row rules. `handlers/list.ts` merges the rule conditions ' +
      'into the user filter map ("RLS wins over same-field user filter") and hands ' +
      'the lot to `buildCondition`, so this file IS a fifth applier there, whatever ' +
      'its name says. Every other read path — single, bulk, sync, expand, ' +
      'extensions — goes through `applyRlsFilters`. MEASURED 2026-09-02 on the case ' +
      'that produced the original leak, a NULL column: `<>` and `!=` both keep only ' +
      'the non-matching non-NULL row, `NOT IN` and `NOT (= ANY(…))` agree, `IN` and ' +
      '`= ANY(…)` agree. It does not diverge where divergence would matter, so ' +
      'folding it in is cleanup, not a fix — and the count would then mean two ' +
      'things. The earlier note here, that a caller filter only "narrows what a ' +
      'caller already may see", was wrong about the list path.',
  ],
  [
    'lib/data/query-parse.ts',
    'parses `?filter=` into that builder’s shape. Same feature as db/dynamic.ts.',
  ],
  [
    'routes/rls.ts',
    'VALIDATES a stored rule on save — the four-value enum an administrator is ' +
      'held to. It decides what may be stored, not what a stored rule means.',
  ],
  [
    'routes/saved-queries.ts',
    'validates operators in a saved user query. Same feature as `?filter=`.',
  ],
]);

/**
 * A file that names the operators at all.
 *
 * Matched on the literals rather than on a type name: a hand-written reading
 * will not import anything in particular, but it cannot avoid naming the
 * operators it branches on. `not_in` is the discriminating one — it is the only
 * string of the four that occurs nowhere else for another reason.
 */
const BRANCHES_ON_OPERATORS = /'not_in'/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // Tests NAME the operators by design — that is what a differential suite is.
    if (name === 'node_modules' || name === 'testing' || name === 'tests') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const readers: string[] = [];
const handWritten: string[] = [];

for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  if (rel === 'lib/tenancy/rule-operators.ts') continue;
  const text = await Bun.file(file).text();
  if (!BRANCHES_ON_OPERATORS.test(text)) continue;
  if (NOT_RULE_READERS.has(rel)) continue;
  readers.push(rel);
  // A reading of the operators that does NOT come from the table is a fifth
  // interpretation written by hand — the thing this gate exists for.
  //
  // An IMPORT, not a mention. `text.includes('rule-operators.js')` was satisfied
  // by a comment: planted on 2026-09-04, a hand-written fifth applier carrying
  // the line `// rule-operators.js is the source of truth; this renders it` was
  // waved through, and the success line then counted it — "3 file(s) render the
  // operators, all via lib/tenancy/rule-operators.js" — which was untrue of the
  // file it had just accepted. A gate that a comment can satisfy is a gate that
  // grades the claim instead of the code. Both real readers
  // (`lib/tenancy/rls.ts`, `lib/tenancy/row-rule-policy.ts`) import it.
  if (!IMPORTS_SOURCE.test(text)) handWritten.push(rel);
}

const suite = await Bun.file(SUITE).text();
const structural = await Bun.file(SINGLE_SOURCE_SUITE).text();

if (REPORT_ONLY) {
  console.log(
    `[rule-interpreters] ${readers.length} file(s) render the operators, ` +
      `${NOT_RULE_READERS.size} declared unrelated\n`,
  );
  for (const rel of readers) console.log(`  ${handWritten.includes(rel) ? '?' : '✓'} ${rel}`);
  for (const [rel] of NOT_RULE_READERS) console.log(`  – ${rel}`);
  process.exit(0);
}

if (handWritten.length > 0) {
  console.error(
    `\n❌ ${handWritten.length} file(s) read the four operators without going through\n` +
      `   lib/tenancy/${SOURCE}\n\n` +
      `   Every hand-written reading is a place the meaning can drift. An audit found\n` +
      `   SEVEN divergences across three of them, one of which was a leak — \`neq\` on a\n` +
      `   NULL column, absent from /api/data and delivered over SSE. A fourth applier\n` +
      `   went uncompared a day longer and disagreed in 18 of 56 cases, because nobody\n` +
      `   had counted it.\n`,
  );
  for (const rel of handWritten) console.error(`  ${rel}`);
  console.error(
    `\n  Render \`RULE_OPERATORS\` instead of deciding again. If the file answers a\n` +
      `  DIFFERENT question — a saved-query filter, a validator, a list of offered\n` +
      `  operators — add it to NOT_RULE_READERS in this file WITH the reason.\n`,
  );
  process.exit(1);
}

// The table is only a single source if the renderings are actually compared.
const missingFromSuite = [
  'applyRlsFilters',
  'buildRowRulePredicate',
  'matchesRlsFilters',
  'rlsJsonConditions',
].filter((n) => !suite.includes(n));
if (missingFromSuite.length > 0) {
  console.error(
    `\n❌ ${missingFromSuite.length} applier(s) are not named by the differential suite.\n`,
  );
  for (const n of missingFromSuite) console.error(`  ${n}`);
  console.error(`\n  ${relative(ROOT, SUITE)} must exercise each one.\n`);
  process.exit(1);
}

if (!structural.includes('RULE_OPERATORS')) {
  console.error(
    `\n❌ ${relative(ROOT, SINGLE_SOURCE_SUITE)} no longer derives from RULE_OPERATORS.\n` +
      `   Without it, a leftover hard-coded spelling in an applier is invisible while\n` +
      `   it happens to match the table.\n`,
  );
  process.exit(1);
}

console.log(
  `[rule-interpreters] OK — ${readers.length} file(s) render the operators, all via ` +
    `lib/tenancy/${SOURCE}; four appliers compared by ${relative(ROOT, SUITE)}`,
);
