#!/usr/bin/env bun
/**
 * Migration safety gate — lints NEW migrations for upgrade hazards.
 *
 * Replaces the Atlas lint job, which never ran: it was wired with
 * `dir-name: zveltio-engine`, an Atlas Cloud feature, so the action demanded
 * `atlas login` and failed on every one of its 31 runs. No migration in this
 * repo has ever actually been linted.
 *
 * Why a gate at all, when `upgrade-path.yml` already boots the last release,
 * seeds data, and migrates HEAD over it: that lane proves a migration is
 * *correct* against data. It cannot prove it is *cheap*, because it has a few
 * dozen seeded rows. A statement that rewrites a table or holds ACCESS
 * EXCLUSIVE finishes there in milliseconds and takes a customer's instance
 * down for an hour. This gate reads the operation, not the clock.
 *
 * Scope: only migrations added or changed against the base ref. Applied
 * migrations are history — they are checksummed by the runner and cannot be
 * edited, so re-grading them as the policy tightens would be noise nobody can
 * act on.
 */

import { $ } from 'bun';

const MIGRATIONS_DIR = 'packages/engine/src/db/migrations/sql';

/**
 * The same marker the runner splits on — `parseMigration()` in
 * `packages/engine/src/db/migrations/index.ts` uses `/^--\s*DOWN\s*$/im`.
 * Kept identical on purpose: linting a different slice of the file than the
 * one that actually executes is how a gate ends up grading fiction.
 *
 * It matters here because the DOWN section is *made of* the statements this
 * linter is built to object to. `001_initial.sql` alone carries 71 DROP TABLE
 * and 108 DROP INDEX below the marker, and every one of them is correct —
 * dropping is what a rollback is for.
 */
const DOWN_MARKER = /^--\s*DOWN\s*$/im;

/**
 * Rules switched off, each for a reason that is about this codebase rather
 * than about the rule being wrong.
 *
 * `require-lock-timeout` / `require-statement-timeout` — right idea, wrong
 *   place, and now handled. Squawk wants a preamble in each file; the runner
 *   opens the one transaction they would live in, so `SET LOCAL` belongs there
 *   — one line covering all 38 existing migrations and every future one,
 *   instead of a ritual 38 authors have to remember. See `applyMigration()`.
 *
 * `prefer-bigint-over-int` / `prefer-identity` — schema taste, not upgrade
 *   risk. They fire on how a column is declared at creation time, which costs
 *   a customer nothing during an upgrade. Out of scope for a safety gate.
 */
const ALWAYS_EXCLUDED = [
  'require-lock-timeout',
  'require-statement-timeout',
  'prefer-bigint-over-int',
  'prefer-identity',
];

/**
 * Only for migrations that run inside the runner's transaction — where
 * `CONCURRENTLY` is illegal and asking for it is asking for the impossible.
 *
 * A migration that opts out with `-- NO TRANSACTION` gets these back, because
 * there the request is both legal and the entire point of opting out. Same
 * marker the runner reads (`isNonTransactional()` in
 * `packages/engine/src/db/migrations/index.ts`), so execution and linting
 * cannot drift into disagreeing about what a file is.
 */
const TRANSACTIONAL_ONLY_EXCLUDED = [
  'require-concurrent-index-creation',
  'require-concurrent-index-deletion',
];

const NO_TRANSACTION_MARKER = /^--\s*NO\s+TRANSACTION\s*$/im;

/**
 * The baseline squash opts out, and only it.
 *
 * `001_initial.sql` is 70 migrations collapsed into one file. It runs against
 * exactly one kind of database: an empty one. Every rule this gate enforces is
 * about a statement that "behaves differently on a customer's populated
 * database than on CI's empty one" — which is, for this file, a condition that
 * cannot arise. It reports four hazards, all of them statements that were safe
 * when they ran years apart against a database that did not yet exist.
 *
 * The practical cost of not having this: any edit to 001 — including a
 * comment — fails the gate on those four. `5c066616` ("leave 001_initial.sql
 * untouched") is that having already happened, and the file has been
 * effectively frozen since, which is the wrong reason to leave engine-owned
 * schema where it is.
 *
 * Deliberately NOT a general escape hatch: the marker is honoured for
 * `001_initial.sql` and nowhere else, so it cannot be pasted into a real
 * migration to make an inconvenient finding go away.
 */
const BASELINE_MARKER = /^--\s*BASELINE\s+SQUASH\s*$/im;
const BASELINE_FILE = '001_initial.sql';

interface Finding {
  file: string;
  line: number;
  rule_name: string;
  level: string;
  message: string;
  help?: string;
}

async function changedMigrations(): Promise<string[]> {
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (explicit.length > 0) return explicit;

  const base = process.env.BASE_REF || 'origin/master';
  const range = `${base}...HEAD`;
  try {
    const out = await $`git diff --name-only --diff-filter=AM ${range} -- ${MIGRATIONS_DIR}`.text();
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.sql'));
  } catch {
    console.error(`Could not diff against ${base}. Pass files explicitly, or set BASE_REF.`);
    process.exit(2);
  }
}

async function lint(file: string): Promise<Finding[]> {
  const raw = await Bun.file(file).text();
  const up = raw.split(DOWN_MARKER)[0];

  if (file.endsWith(BASELINE_FILE) && BASELINE_MARKER.test(up)) {
    console.log(
      `   ${file.split('/').pop()}: baseline squash — runs only on an empty database, skipped.`,
    );
    return [];
  }

  // Squawk reads paths, not stdin, and the reported filename comes from the
  // path — so the temp file keeps the original basename to keep output honest.
  const tmp = `${process.env.TMPDIR || '/tmp'}/squawk-${Date.now()}-${file.split('/').pop()}`;
  await Bun.write(tmp, up);

  const inTransaction = !NO_TRANSACTION_MARKER.test(up);
  const excluded = inTransaction
    ? [...ALWAYS_EXCLUDED, ...TRANSACTIONAL_ONLY_EXCLUDED]
    : ALWAYS_EXCLUDED;

  try {
    // `--assume-in-transaction`: the runner's BEGIN/COMMIT is the ambient
    // context these statements execute in. Without it squawk asks for
    // `IF NOT EXISTS` guards against partial application, which cannot happen
    // when the whole migration rolls back as a unit.
    //
    // Withheld from `-- NO TRANSACTION` files, and that is the useful half:
    // there partial application is exactly what happens on failure, so the
    // demand for idempotent statements becomes a real requirement rather than
    // noise, and the linter starts making it.
    const proc = Bun.spawn(
      [
        'bun',
        'x',
        'squawk',
        ...(inTransaction ? ['--assume-in-transaction'] : []),
        `--exclude=${excluded.join(',')}`,
        '--reporter',
        'json',
        tmp,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    const parsed: Finding[] = out.trim() ? JSON.parse(out) : [];
    return parsed.map((f) => ({ ...f, file }));
  } finally {
    await $`rm -f ${tmp}`.quiet();
  }
}

const files = await changedMigrations();

if (files.length === 0) {
  console.log('✅ No new or changed migrations to check.');
  process.exit(0);
}

console.log(`Checking ${files.length} migration(s):`);
for (const f of files) console.log(`   ${f}`);
console.log();

const findings: Finding[] = [];
for (const f of files) findings.push(...(await lint(f)));

if (findings.length === 0) {
  console.log('✅ No upgrade hazards found.');
  process.exit(0);
}

for (const f of findings) {
  console.log(`${f.level === 'Warning' ? '⚠️ ' : '❌'} ${f.file}:${f.line}`);
  console.log(`   [${f.rule_name}] ${f.message}`);
  if (f.help) console.log(`   ${f.help}`);
  console.log(`   https://squawkhq.com/docs/${f.rule_name}`);
  console.log();
}

console.log(
  `${findings.length} hazard(s) found.\n\n` +
    `These are not style notes — each one describes a statement that behaves\n` +
    `differently on a customer's populated database than on CI's empty one.\n` +
    `If a hazard is deliberate and understood, say so in the migration's header\n` +
    `comment and add the rule to EXCLUDED here with the reasoning, so the next\n` +
    `person inherits the argument rather than the silence.\n`,
);
process.exit(1);

/**
 * Writing an index on a table that already has rows? Add `-- NO TRANSACTION`
 * to the migration and use `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. The
 * runner will skip the transaction wrapper, and this gate will start holding
 * the file to the stricter standard that choice earns: every statement has to
 * be safe to run twice, because nothing rolls back if one of them fails.
 */
