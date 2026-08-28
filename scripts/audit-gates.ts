#!/usr/bin/env bun
/**
 * Do the gates fail when they should?
 *
 * Every gate in this repository runs in CI — that much is verifiable by reading
 * the workflow. What reading cannot tell you is whether a gate would CATCH the
 * thing it names. `scripts/dr-drill.sh` was cited as evidence for a P0 for two
 * months while aborting on its first command; the row in TECHNICAL-GAPS said
 * DONE the whole time.
 *
 * So: plant the violation each gate claims to detect, run the gate, and record
 * whether it noticed. A gate that stays green on a planted violation is telling
 * us it is decoration.
 *
 * Nothing is left behind. Each case writes one file, runs one command, deletes
 * the file — and the run refuses to start if any plant path already exists, so
 * a probe can never be mistaken for somebody's own file.
 */
import { $ } from 'bun';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Case = {
  gate: string;
  /** The command that should FAIL once the violation is planted. */
  cmd: string;
  /** Where to plant it, and what. */
  file: string;
  body: string;
  /**
   * `append` for a gate that reads an explicit list of files and will never
   * open a new one — `check-i18n-core` is the case. The original is held in
   * memory and written back byte for byte, so the file is untouched either way.
   */
  mode?: 'create' | 'append';
};

/**
 * A literal `${t}` for the probe bodies below.
 *
 * Written as a string it trips `noTemplateCurlyInString`, which exists to catch
 * an interpolation somebody forgot to make a template — and here the whole point
 * is that it stays text, because it is source code being written to disk. Built
 * from pieces rather than suppressed: a rule that is right to fire deserves an
 * answer, not an exception.
 */
const INTERP = '$' + '{t}';

const CASES: Case[] = [
  {
    // The `.catch` must swallow a QUERY — the gate looks for `.execute(` or a
    // `sql` template within four lines. A `.catch` on any other call is not the
    // thing it is hunting, and a first version of this probe planted exactly
    // that and reported a working gate as decoration.
    gate: 'check-fabricated-success',
    cmd: 'bun run scripts/check-fabricated-success.ts',
    file: 'packages/engine/src/lib/__gate_probe.ts',
    body:
      "import { sql } from 'kysely';\n" +
      'export async function probe(db: unknown) {\n' +
      '  return sql`SELECT 1`.execute(db as never).catch(() => ({ rows: [] }));\n}\n',
  },
  {
    // A route handler reaching for a tenant table on the raw pool — the query
    // that runs outside the request transaction and therefore outside RLS.
    // Planted under `routes/` because that is the only tree the gate walks.
    gate: 'check-tenant-table-on-pool',
    cmd: 'bun run scripts/check-tenant-table-on-pool.ts',
    file: 'packages/engine/src/routes/__gate_probe.ts',
    body:
      "import type { Database } from '../db/index.js';\n" +
      'export const probe = (db: Database) =>\n' +
      "  db.selectFrom('zv_api_keys').selectAll().execute();\n",
  },
  {
    // A backtick inside an SQL `--` comment, which ends the template early.
    gate: 'check-sql-template-backticks',
    cmd: 'bun run scripts/check-sql-template-backticks.ts',
    file: 'packages/engine/src/lib/__gate_probe.ts',
    body:
      "import { sql } from 'kysely';\n" +
      'export const q = sql`\n' +
      '  -- DML on all of `public` is what made this reachable\n' +
      '  SELECT 1\n' +
      '`;\n',
  },
  {
    gate: 'check-raw-sql-identifiers',
    cmd: 'bun run scripts/check-raw-sql-identifiers.ts',
    file: 'packages/engine/src/lib/__gate_probe.ts',
    body:
      "import { sql } from 'kysely';\n" +
      'export const d = (t: string) => sql.raw(`DROP TABLE "' +
      INTERP +
      '"`);\n',
  },
  {
    // The two-line form, which the gate could not see until this audit.
    gate: 'check-raw-sql-identifiers (multi-line call)',
    cmd: 'bun run scripts/check-raw-sql-identifiers.ts',
    file: 'packages/engine/src/lib/__gate_probe.ts',
    body:
      "import { sql } from 'kysely';\n" +
      'export const d = (t: string) => sql\n  .raw(`DROP TABLE "' +
      INTERP +
      '"`);\n',
  },
  {
    gate: 'check-numeric-string-arithmetic',
    cmd: 'bun run scripts/check-numeric-string-arithmetic.ts',
    file: 'packages/engine/src/lib/__gate_probe.ts',
    body: "export function total(row: { amount: string }) {\n  return '0' + row.amount;\n}\n",
  },
  {
    gate: 'check-studio-api-prefix',
    cmd: 'bun run scripts/check-studio-api-prefix.ts',
    file: 'packages/studio/src/lib/__gate_probe.ts',
    body:
      "import { api } from '$lib/api.js';\n" +
      "export const load = () => api.get('/extensions/crm/contacts');\n",
  },
  {
    // A page on the gate's explicit list, not any file that happens to be a
    // `.svelte` — a first version planted into a new file the gate never reads
    // and concluded, wrongly, that the gate was dead.
    gate: 'check-i18n-core',
    cmd: 'bun run scripts/check-i18n-core.ts',
    // On the gate's list, not merely a `.svelte` somewhere: the check reads an
    // explicit set of page paths, and a first version of this probe planted into
    // a file it never opens and concluded the gate was dead.
    file: 'packages/studio/src/routes/(admin)/ai/chat/+page.svelte',
    body: '\n<p>A hardcoded English sentence on a translated page.</p>\n',
    mode: 'append',
  },
  {
    gate: 'check-embedded-migrations-fresh',
    cmd: 'bun run scripts/check-embedded-migrations-fresh.ts',
    file: 'packages/engine/src/db/migrations/sql/099__gate_probe.sql',
    body: '-- planted by scripts/audit-gates.ts\nSELECT 1;\n',
  },
  {
    // Appends a hand-written comment to a generated file. The membership half
    // of this gate would not notice — the migration set is unchanged — so a
    // plant that only added a .sql file would have proved the wrong half.
    gate: 'check-embedded-migrations-fresh',
    cmd: 'bun run scripts/check-embedded-migrations-fresh.ts',
    file: 'packages/engine/src/db/migrations/embedded.ts',
    body: '\n// a note written by hand into a file the next build overwrites\n',
    mode: 'append',
  },
  {
    // Must be a file the sync actually writes. The gate restores the synced
    // trees itself, so it hands back the planted bytes and the harness below
    // writes the original over them — the two restores agree.
    gate: 'check-ext-snapshot-fresh',
    cmd: 'bun run scripts/check-ext-snapshot-fresh.ts',
    file: 'packages/studio/src/lib/ext/content/pages/components/builder/BlockList.svelte',
    body: '\n<!-- edited in the snapshot, where the next build deletes it -->\n',
    mode: 'append',
  },
];
// Refuse only if a plant path already exists — precise, where "the tree is
// clean" was not. Blocking on any modification meant the audit could not run
// alongside the very work it checks, and what actually matters is that no
// plant is ever mistaken for somebody's file.
for (const c of CASES) {
  const appends = c.mode === 'append';
  if (!appends && existsSync(c.file)) {
    console.error(`❌ ${c.file} already exists — refusing to overwrite it with a probe.`);
    process.exit(1);
  }
  if (appends && !existsSync(c.file)) {
    console.error(`❌ ${c.file} does not exist — an append probe has nothing to append to.`);
    process.exit(1);
  }
}

let caught = 0;
const missed: string[] = [];

for (const c of CASES) {
  const original = c.mode === 'append' ? readFileSync(c.file, 'utf8') : null;
  mkdirSync(dirname(c.file), { recursive: true });
  writeFileSync(c.file, original === null ? c.body : original + c.body);
  let failed = false;
  try {
    await $`sh -c ${c.cmd}`.quiet();
  } catch {
    failed = true;
  }
  if (original === null) rmSync(c.file, { force: true });
  else writeFileSync(c.file, original);
  if (failed) {
    caught++;
    console.log(`  ✅ ${c.gate.padEnd(34)} caught its violation`);
  } else {
    missed.push(c.gate);
    console.log(`  ❌ ${c.gate.padEnd(34)} STAYED GREEN on a planted violation`);
  }
}

const leftovers = CASES.filter((c) => c.mode !== 'append' && existsSync(c.file)).map((c) => c.file);
if (leftovers.length) {
  console.error('\n❌ probe left files behind:\n  ' + leftovers.join('\n  '));
  process.exit(1);
}

console.log(`\n  ${caught}/${CASES.length} gates failed when they should.`);
if (missed.length) {
  console.error(`\n❌ decoration, not a gate: ${missed.join(', ')}`);
  process.exit(1);
}
