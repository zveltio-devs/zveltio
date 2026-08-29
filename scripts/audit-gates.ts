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
    // A route handler reaching for a tenant table on `poolDb` — the handle with
    // no tenant binding, where the route's own `db` is the request-scoped proxy.
    // Planted under `routes/` because that is the only tree the gate walks.
    gate: 'check-tenant-table-on-pool',
    cmd: 'bun run scripts/check-tenant-table-on-pool.ts',
    file: 'packages/engine/src/routes/__gate_probe.ts',
    body:
      "import type { Database } from '../db/index.js';\n" +
      'export const probe = (poolDb: Database) =>\n' +
      "  poolDb.selectFrom('zv_api_keys').selectAll().execute();\n",
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
  {
    // A route module reaching for the bare `checkPermission(user, 'admin', '*')`
    // instead of the permission the route actually needs. The gate reads the
    // routes tree line by line, so one planted file is the whole violation.
    gate: 'admin-gate-check',
    cmd: 'bun run scripts/admin-gate-check.ts',
    file: 'packages/engine/src/routes/__gate_probe_admin.ts',
    body:
      'export const probe = (user: string, checkPermission: Function) =>\n' +
      "  checkPermission(user, 'admin', '*');\n",
  },
  {
    // A deep import past a subsystem barrel (H-08). `lib/tenancy` ships an
    // index.ts, so reaching `lib/tenancy/column-permissions.js` from a route is
    // exactly what the gate refuses.
    //
    // `append` onto a TRACKED file, and this is the whole lesson of the case:
    // the gate enumerates through `git ls-files`, so a freshly created probe is
    // invisible to it and the first version of this case reported a working gate
    // as decoration. The blind spot is real but not the gate's problem — CI
    // checks out a commit, where every file is tracked.
    //
    // `backup.ts` rather than `data.ts`: the latter is the one file exempted for
    // `lib/data`, and picking an exempted target is the same mistake wearing a
    // different hat.
    gate: 'import-boundaries',
    cmd: 'bun run scripts/import-boundaries.ts',
    file: 'packages/engine/src/routes/backup.ts',
    body: "\nexport { getColumnAccess } from '../lib/tenancy/column-permissions.js';\n",
    mode: 'append',
  },
  {
    // One more `noExplicitAny` suppression than the baseline records. The
    // ratchet counts markers, so the probe has to carry a real one.
    gate: 'any-ratchet',
    cmd: 'bun run scripts/any-ratchet.ts',
    file: 'packages/engine/src/lib/__gate_probe_any.ts',
    body:
      '// biome-ignore lint/suspicious/noExplicitAny: gate probe\n' +
      'export const probe: any = null;\n',
  },
  {
    // Two migrations both creating the same table. Whichever runs second is a
    // silent no-op under IF NOT EXISTS, so the columns the second one meant to
    // ship never exist and the failure surfaces far away.
    // Planted in the SIBLING repo, and that is the point of the case. Two engine
    // migrations creating one table are deliberately NOT two creators — `add()`
    // keys on owner, so a table split across an owner's own migrations is fine.
    // Only distinct owners shadow each other. A probe inside the engine reports
    // this working gate as decoration, which is what the first version did.
    gate: 'check-duplicate-table-creators',
    cmd: 'bun run scripts/check-duplicate-table-creators.ts',
    file: '../zveltio-extensions/analytics/dashboard/engine/migrations/900_gate_probe_dup.sql',
    body: 'CREATE TABLE IF NOT EXISTS zv_schema_versions (id uuid PRIMARY KEY);\n',
  },
  {
    // The gate that keeps the others honest, kept honest itself.
    //
    // The violation is a NEW gate joining CI without either a planted case or a
    // recorded reason — the exact thing that let twenty-two of them accumulate
    // unnoticed while the plan recorded "11/11". Planted by appending a step to
    // the workflow, because that is how a real one would arrive.
    //
    // `append`, so the workflow is restored byte for byte; `create` would leave
    // CI defined by a probe.
    gate: 'check-gate-coverage',
    cmd: 'bun run scripts/check-gate-coverage.ts',
    file: '.github/workflows/ci.yml',
    body: '\n        run: bun run scripts/__gate_probe_uncovered.ts\n',
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
