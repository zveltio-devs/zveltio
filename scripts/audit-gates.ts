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
  /**
   * Scripts this case exercises INDIRECTLY, when the command runs a wrapper
   * rather than the gate itself. Two cases need a wrapper: one has to seed a
   * row in the database and clean it up afterwards, the other has to remove a
   * call from a tracked file and put it back. `check-gate-coverage` reads the
   * commands to decide what is proved, and a wrapper hides the gate from it —
   * so the case says so out loud instead of the checker guessing.
   */
  proves?: string[];
  /**
   * A substring the gate's output must contain for the failure to count.
   *
   * Without this, "the command exited non-zero" is the whole test — and a gate
   * that cannot RUN also exits non-zero. Three cases here need a database, and
   * in the job where `audit:gates` runs there is none: two of them were passing
   * because the gate said "no database to build against", which is a refusal to
   * look, not a violation found. That is the exact false green this whole file
   * exists to kill, so the file now has to be honest about it too.
   */
  expect?: string;
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

/**
 * `${…}` for probe bodies that are themselves TypeScript.
 *
 * Same reason as `INTERP` directly above, and the same answer: written whole it
 * trips `noTemplateCurlyInString`, and that rule is right — it exists to catch
 * an interpolation somebody forgot to make a template. Here the text IS source
 * being written to disk, so it is assembled rather than suppressed.
 */
const CURLY = (inner: string) => '$' + '{' + inner + '}';

/**
 * The `noExplicitAny` suppression marker, in pieces.
 *
 * Same reason as `INTERP` above, one rule further: `any-ratchet` counts these
 * markers across the repository, so a probe carrying a literal one makes THIS
 * file a violation of the gate it is testing. CI caught it — `scripts: 14 → 15`
 * — which is the ratchet doing its job on the file written to prove the ratchet
 * does its job.
 */
const ANY_MARKER = 'biome-' + 'ignore lint/suspicious/noExplicitAny';

const CASES: Case[] = [
  {
    // The meta-gate, on itself. Nothing proved that IT would notice a gate that
    // stays green — its own correctness rested on reading it. It cannot plant
    // into its own source, so it reads extra cases from a file, and this plants
    // one whose command always succeeds. A run that does not call that
    // decoration is a run that would have missed every dead gate.
    gate: 'audit-gates',
    cmd: 'AUDIT_GATES_ONLY=plant-decoration bun run scripts/audit-gates.ts',
    file: 'quality-gates/audit-gates-extra-cases.json',
    body: '[\n  {\n    "gate": "plant-decoration",\n    "cmd": "true",\n    "file": "quality-gates/plant-decoration-target.txt",\n    "body": "planted by audit-gates, for audit-gates\\n"\n  }\n]\n',
  },
  {
    // Every message key an extension's Studio page renders must belong to that
    // extension. A page borrowing another extension's namespace works only
    // while both are installed; uninstall the owner and the label renders as a
    // raw key. Ratcheted, so the plant is a NEW borrower.
    gate: 'check-extension-i18n-ownership',
    cmd: 'bun run scripts/check-extension-i18n-ownership.ts',
    file: '../zveltio-extensions/search/studio/pages/plant-borrow.svelte',
    body: [
      '<script lang="ts">',
      "  import { m } from '$lib/paraglide/messages';",
      '</script>',
      '',
      "<h1>{m['communications.mail.subject']()}</h1>",
      '',
    ].join('\n'),
  },
  {
    // An SDUI schema is a promise about an API. This one promises a resource
    // the extension's engine never serves — the contradiction the gate is for.
    // It reads the schema files and the extension source, so no running API is
    // needed; the baseline said otherwise and the baseline was wrong.
    gate: 'check-sdui-contract',
    cmd: 'bun run scripts/check-sdui-contract.ts',
    file: '../zveltio-extensions/search/studio/schemas/plant-contract.json',
    body: '{\n  "sduiSchema": 1,\n  "title": "search.plant.title",\n  "resources": [\n    {\n      "id": "plant",\n      "label": "search.plant.label",\n      "dataSource": "/ext/search/plant-does-not-exist",\n      "dataPath": "items"\n    }\n  ]\n}',
  },
  {
    // The gate splits severity: `schema.ts` drift alone is a warning, and it
    // exits non-zero only on the kind that crashes at runtime — a `zv_*` table
    // or a column the code queries and no migration creates. Two earlier plants
    // (an orphan interface; a column no table has) both left it green, which is
    // recorded in the baseline; this is the shape that does not.
    gate: 'schema-drift-check',
    cmd: 'bun run scripts/schema-drift-check.ts',
    file: 'packages/engine/src/routes/plant-missing-table.ts',
    body: [
      "import { Hono } from 'hono';",
      "import type { Database } from '../db/index.js';",
      '',
      'export function plantMissingTableRoutes(db: Database): Hono {',
      '  const app = new Hono();',
      "  app.get('/plant', async (c) => {",
      "    const rows = await db.selectFrom('zv_plant_missing_table').selectAll().execute();",
      '    return c.json(rows);',
      '  });',
      '  return app;',
      '}',
      '',
    ].join('\n'),
  },
  {
    // Does this INSERT match the table it writes to? The gate builds the real
    // schema and compares, so it needs a database; the probe hands it the same
    // one the rest of the run uses.
    gate: 'check-insert-schema-match',
    expect: 'plant_missing_column',
    // `$TEST_DATABASE_URL` without braces on purpose: the braced form trips
    // `noTemplateCurlyInString`, and writing it as a template literal instead
    // hid the command from `check-gate-coverage`, which reads single-quoted
    // commands. Two rules pulling opposite ways; the plain variable satisfies
    // both. With nothing set the gate exits 0 with a note and this case fails
    // loudly as decoration, which is the right direction to fail in.
    cmd: 'SEAM_DATABASE_URL="$TEST_DATABASE_URL" bun run scripts/check-insert-schema-match.ts',
    file: '../zveltio-extensions/search/engine/plant-insert.ts',
    body: [
      "import { sql } from 'kysely';",
      '',
      '// A column `zv_settings` does not have.',
      'export async function plantInsert(db: unknown) {',
      '  await sql`',
      '    INSERT INTO zv_settings (key, value, plant_missing_column)',
      "    VALUES ('a', 'b', 'c')",
      '  `.execute(db as never);',
      '}',
      '',
    ].join('\n'),
  },
  {
    // A Studio page in the engine that talks to `/ext/*` but that no extension
    // declares is an orphan: the extension can be uninstalled and the page
    // stays, pointing at routes that are gone.
    gate: 'check-extension-page-ownership',
    cmd: 'bun run scripts/check-extension-page-ownership.ts',
    file: 'packages/studio/src/routes/(admin)/plant-orphan/+page.svelte',
    body: [
      '<script lang="ts">',
      "  const res = fetch('/ext/plant-orphan/data');",
      '</script>',
      '',
      '<p>{res}</p>',
      '',
    ].join('\n'),
  },
  {
    // A privileged handler on the MANDATORY list must keep its `auditLog()`
    // call. The violation is therefore a REMOVAL, not an addition — a new
    // unaudited route is not on the list and changes nothing, which a first
    // version of this case learned by staying green.
    //
    // So the plant is a script: it strips one `auditLog(` call from a mandatory
    // handler, runs the two real commands CI runs, restores the file in a
    // `finally`, and answers with the gate's own exit code.
    gate: 'audit-regression-check',
    cmd: 'bun run scripts/plant-audit-regression.ts',
    proves: ['scripts/audit-regression-check.ts', 'scripts/audit-inventory.ts'],
    file: 'scripts/plant-audit-regression.ts',
    body: [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      '',
      "const TARGET = 'packages/engine/src/routes/admin/system-routes.ts';",
      "const original = readFileSync(TARGET, 'utf8');",
      '',
      '// `audit-inventory.ts` rewrites this as a side effect, so it is held and',
      '// put back too — a probe that leaves the tree dirty is a probe that will',
      '// eventually be committed by accident.',
      "const COVERAGE_DOC = 'docs/AUDIT-COVERAGE.md';",
      "const coverageDoc = readFileSync(COVERAGE_DOC, 'utf8');",
      '',
      'let code = 1;',
      'try {',
      '  // Neutralise every audit call in the file without changing its shape.',
      "  writeFileSync(TARGET, original.replaceAll('auditLog(', 'noAuditPlanted('));",
      "  const inv = Bun.spawnSync(['bun', 'run', 'scripts/audit-inventory.ts'], {",
      "    stdout: 'inherit',",
      "    stderr: 'inherit',",
      '  });',
      '  if (inv.exitCode !== 0) {',
      '    code = inv.exitCode ?? 1;',
      '  } else {',
      "    const res = Bun.spawnSync(['bun', 'run', 'scripts/audit-regression-check.ts'], {",
      "      stdout: 'inherit',",
      "      stderr: 'inherit',",
      '    });',
      '    code = res.exitCode ?? 1;',
      '  }',
      '} finally {',
      '  writeFileSync(TARGET, original);',
      '  writeFileSync(COVERAGE_DOC, coverageDoc);',
      '}',
      'process.exit(code);',
      '',
    ].join('\n'),
  },
  {
    // A test run must not leave collections or ghost tables behind. The
    // violation lives in the DATABASE, not in a file, so the plant is a script
    // that seeds one and then runs the real gate, passing its exit code back.
    // The gate under test is the real one; only the leftover is manufactured.
    gate: 'check-test-leftovers',
    expect: 'plantleft_',
    cmd: 'bun run scripts/plant-test-leftover.ts',
    proves: ['scripts/check-test-leftovers.ts'],
    file: 'scripts/plant-test-leftover.ts',
    body: [
      "import { sql } from 'kysely';",
      "import { createDb } from '../packages/engine/src/db/index.js';",
      '',
      'const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;',
      'if (!url) process.exit(2);',
      'const db = createDb(url);',
      'const name = `plantleft_' + CURLY('Date.now()') + '`;',
      'try {',
      '  await sql`INSERT INTO zvd_collections (name, display_name) VALUES (' +
        CURLY('name') +
        ', ' +
        CURLY('name') +
        ')`.execute(db);',
      '} finally {',
      '  await db.destroy().catch(() => {});',
      '}',
      '',
      "const proc = Bun.spawnSync(['bun', 'run', 'scripts/check-test-leftovers.ts'], {",
      "  stdout: 'inherit',",
      "  stderr: 'inherit',",
      '});',
      '',
      '// Clean up before answering, so the plant does not outlive the probe.',
      'const db2 = createDb(url);',
      'try {',
      '  await sql`DELETE FROM zvd_collections WHERE name = ' + CURLY('name') + '`.execute(db2);',
      '} finally {',
      '  await db2.destroy().catch(() => {});',
      '}',
      'process.exit(proc.exitCode ?? 0);',
      '',
    ].join('\n'),
  },
  {
    // Lints NEW migrations for upgrade hazards. In CI it takes the file list
    // from `git diff`, which a planted file cannot appear in — a plant that is
    // never seen proves nothing — so the file is handed to it explicitly, which
    // is the same code path with the same linter.
    gate: 'check-migration-safety',
    cmd: 'bun run scripts/check-migration-safety.ts packages/engine/src/db/migrations/sql/999_plant_hazard.sql',
    file: 'packages/engine/src/db/migrations/sql/999_plant_hazard.sql',
    body: [
      '-- planted by audit-gates: a hazard squawk must refuse.',
      '-- Adding a NOT NULL column with no default rewrites the whole table and',
      '-- fails outright on any existing row.',
      'ALTER TABLE zv_settings ADD COLUMN plant_hazard text NOT NULL;',
      '',
    ].join('\n'),
  },
  {
    // Studio build output must carry a version marker matching the engine.
    // A marker naming a different version is exactly the stale embed the gate
    // exists to refuse.
    gate: 'check-studio-embed-freshness',
    cmd: 'REQUIRE_STUDIO_DIST=1 bun run scripts/check-studio-embed-freshness.ts',
    file: 'packages/studio/dist/.zveltio-studio-version',
    body: '0.0.0-planted\n',
  },
  {
    // A security rule is implemented ONCE. Every hand-written dispatch over a
    // filter operator so far has covered the comparisons and silently dropped
    // `in`/`not_in` — which means a row policy written with `in` stopped
    // applying, quietly, on that path.
    gate: 'check-duplicate-rules',
    cmd: 'bun run scripts/check-duplicate-rules.ts',
    file: 'packages/engine/src/lib/plant-duplicate-rule.ts',
    body: [
      'export function plantDuplicateRule(cond: { op: string; value: unknown }): string {',
      "  if (cond.op === 'eq') return '=';",
      "  if (cond.op === 'neq') return '!=';",
      "  return '?';",
      '}',
      '',
    ].join('\n'),
  },
  {
    // The SDK carries a copy of the shared Studio vocabulary. A key added to
    // the source without regenerating leaves the copy stale, and `--check` is
    // the mode CI runs.
    gate: 'sync-shared-message-keys',
    cmd: 'bun run scripts/sync-shared-message-keys.ts --check',
    // Planted on the generated COPY, not on the source. Appending to the source
    // would be appending to JSON, and the gate would then fail on a parse error
    // rather than on the drift it exists to catch — a plant that passes for the
    // wrong reason proves nothing.
    file: 'packages/sdk/src/validate/shared-message-keys.ts',
    mode: 'append',
    body: '\n// planted by audit-gates: the copy no longer matches its source\n',
  },
  {
    // What the database looks like after a real install, recorded so a change
    // to it has to be deliberate. Touch the record and the comparison fails —
    // which is the whole mechanism.
    gate: 'schema-snapshot',
    expect: 'no longer matches',
    cmd: 'bun run scripts/schema-snapshot.ts',
    file: 'packages/engine/src/db/installed-schema.snapshot.txt',
    mode: 'append',
    body: '\n-- planted by audit-gates: a line the installed schema does not have\n',
  },
  {
    // Coverage ratchet. It reads an lcov rather than measuring, so the plant is
    // an lcov: one file, one line, uncovered. Nothing else in the run is
    // touched, and the gate is pointed at it explicitly.
    gate: 'coverage-gate',
    cmd: 'bun run scripts/coverage-gate.ts packages/engine/plant-coverage.lcov',
    file: 'packages/engine/plant-coverage.lcov',
    body: [
      'SF:packages/engine/src/lib/plant.ts',
      'DA:1,0',
      'LF:1',
      'LH:0',
      'end_of_record',
      '',
    ].join('\n'),
  },
  {
    // An extension declares its Studio pages in its manifest; each page names a
    // schema file that has to exist and to declare `sduiSchema` + `title`. A
    // manifest promising a page it does not ship is the failure.
    gate: 'check-extension-sdui-schemas',
    cmd: 'bun run scripts/check-extension-sdui-schemas.ts',
    file: '../zveltio-extensions/plant-sdui-ext/manifest.json',
    body: JSON.stringify(
      {
        name: 'plant-sdui-ext',
        version: '1.0.0',
        studio: { pages: [{ path: 'plant', schema: 'plant-missing.json' }] },
      },
      null,
      2,
    ),
  },
  {
    // An in-process extension reading `process.env` sees the ENGINE's whole
    // environment — every secret it was ever given. The contract is
    // `ctx.config.vars`, and the gate exists because four of twelve extensions
    // reached for the environment anyway.
    gate: 'check-ambient-authority',
    cmd: 'bun run scripts/check-ambient-authority.ts',
    file: '../zveltio-extensions/search/engine/plant-ambient.ts',
    body: [
      'export function plantAmbient(): string | undefined {',
      '  return process.env.DATABASE_URL;',
      '}',
      '',
    ].join('\n'),
  },
  {
    // The embedded worker runtime must be the one in the repository. It is
    // generated from this source and carries its hash, so touching the source
    // without regenerating is exactly the drift the gate exists for.
    gate: 'check-worker-source-fresh',
    cmd: 'bun run scripts/check-worker-source-fresh.ts',
    file: 'packages/engine/src/lib/worker-extension-runtime.ts',
    mode: 'append',
    body: '\n// planted by audit-gates: source changed without regenerating the embedded copy\n',
  },
  {
    // A handler that writes twice must say so. Ratcheted, so the plant has to
    // be a NEW handler above the baseline, not an edit to a recorded one.
    gate: 'check-atomic-writes',
    cmd: 'bun run scripts/check-atomic-writes.ts',
    file: 'packages/engine/src/routes/plant-atomic-routes.ts',
    body: [
      "import { Hono } from 'hono';",
      "import type { Database } from '../db/index.js';",
      '',
      'export function plantAtomicRoutes(db: Database): Hono {',
      '  const app = new Hono();',
      "  app.post('/plant', async (c) => {",
      "    await db.insertInto('zv_settings').values({ key: 'a', value: '1' }).execute();",
      "    await db.insertInto('zv_settings').values({ key: 'b', value: '2' }).execute();",
      '    return c.json({ ok: true });',
      '  });',
      '  return app;',
      '}',
      '',
    ].join('\n'),
  },
  {
    // The lint-warning ratchet. `isNaN` is a warning (noGlobalIsNan), so a new
    // file carrying two of them lands above the recorded count.
    gate: 'lint-warning-ratchet',
    cmd: 'bun run scripts/lint-warning-ratchet.ts',
    file: 'packages/engine/src/lib/plant-lint-warning.ts',
    body: [
      'export function plantWarning(a: unknown, b: unknown): boolean {',
      '  return isNaN(a as number) || isNaN(b as number);',
      '}',
      '',
    ].join('\n'),
  },
  {
    // A static path registered AFTER a same-method param path is unreachable:
    // the param route wins and captures the static segment. The gate exists
    // because that shipped once — `GET /api/flows/dlq` matched `/:id`, and
    // `WHERE id = 'dlq'` on a uuid column answered 500.
    gate: 'route-collision-check',
    cmd: 'bun run scripts/route-collision-check.ts',
    file: 'packages/engine/src/routes/plant-collision-routes.ts',
    body: [
      "import { Hono } from 'hono';",
      '',
      'export function plantCollisionRoutes(): Hono {',
      '  const app = new Hono();',
      "  app.get('/:id', (c) => c.json({ id: c.req.param('id') }));",
      "  app.get('/dlq', (c) => c.json({ ok: true }));",
      '  return app;',
      '}',
      '',
    ].join('\n'),
  },
  {
    // A router built on `poolDb` needs a SECOND connection while the request is
    // already holding one for its tenant transaction. At `c = DB_POOL_MAX` the
    // second can never arrive, so the instance stops rather than slows — which
    // is why the gate wants such a router listed in TXN_SKIP_PREFIXES.
    gate: 'check-pooldb-txn-skip',
    cmd: 'bun run scripts/check-pooldb-txn-skip.ts',
    file: 'packages/engine/src/routes/index.ts',
    mode: 'append',
    body: [
      '',
      '// planted by audit-gates: a poolDb router with no TXN_SKIP_PREFIXES entry',
      "// app.route('/api/plantpool', plantPoolRoutes(poolDb, auth));",
      '',
    ].join('\n'),
  },
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
    // `append` on a TRACKED file — the third gate in this file that enumerates
    // through `git ls-files`, after import-boundaries and check-migration-safety.
    // A created probe is invisible to all three, and the first version of this
    // case only went red because `audit-gates.ts` itself then held a literal
    // marker and pushed the repo over its own baseline. It reported the right
    // answer for the wrong reason, which is worse than reporting the wrong one.
    gate: 'any-ratchet',
    cmd: 'bun run scripts/any-ratchet.ts',
    file: 'packages/engine/src/routes/backup.ts',
    body: `\n// ${ANY_MARKER}: gate probe\nexport const __gateProbeAny: any = null;\n`,
    mode: 'append',
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
    // A FIFTH reader of the four operators, in a file of its own.
    //
    // Planted as a new exported function that branches on `not_in`, which is the
    // shape a real one takes: nobody adds an interpreter by importing a marker
    // interface, they add it by writing the switch. The gate must notice it is
    // neither registered nor in the differential suite.
    gate: 'check-rule-interpreters',
    cmd: 'bun run scripts/check-rule-interpreters.ts',
    file: 'packages/engine/src/lib/tenancy/gate-probe-interpreter.ts',
    body:
      'export function gateProbeInterpretRule(op: string): string {\n' +
      "  if (op === 'eq') return '=';\n" +
      "  if (op === 'neq') return '<>';\n" +
      "  if (op === 'in') return 'IN';\n" +
      "  if (op === 'not_in') return 'NOT IN';\n" +
      "  throw new Error('unknown');\n" +
      '}\n',
  },
  {
    // A new table that carries no `tenant_id` and declares nothing. It looks
    // identical to a deliberate instance-level table, which is the whole reason
    // the gate exists.
    //
    // One line on purpose: the first version of the gate demanded the closing
    // paren on a line of its own and was blind to exactly this shape. Planting
    // found that; reading the regex would not have.
    gate: 'check-tenant-boundary',
    cmd: 'bun run scripts/check-tenant-boundary.ts',
    file: 'packages/engine/src/db/migrations/sql/902_gate_probe_boundary.sql',
    body:
      'CREATE TABLE IF NOT EXISTS zz_boundary_probe ' +
      '(id uuid PRIMARY KEY, flow_id uuid REFERENCES zv_flows(id));\n',
  },
  {
    // A NEW bare admin check in an extension. The 113 already there are frozen
    // per file; this plants a 114th in a file that has one, so only the ratchet
    // can catch it — a gate that merely counted the total would too, but one
    // that had stopped scanning the sibling at all would not.
    //
    // `append` on a TRACKED file in the sibling: the gate walks the filesystem,
    // but a created file would also shift the per-file baseline lookup to a name
    // that is not in it, which is the OTHER failure and not the one under test.
    gate: 'admin-gate-check (sibling ratchet)',
    cmd: 'bun run scripts/admin-gate-check.ts',
    file: '../zveltio-extensions/search/engine/routes.ts',
    body:
      '\nexport const __gateProbe = (uid: string, checkPermission: Function) =>\n' +
      "  checkPermission(uid, 'admin', '*');\n",
    mode: 'append',
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
/**
 * Extra cases, read from disk.
 *
 * The meta-gate had no case of its own: nothing proved that IT would notice a
 * gate that stays green. It cannot plant into its own source, so it accepts
 * cases from a file instead, and the planted file carries a case whose command
 * always succeeds — which this run must then report as decoration.
 *
 * `AUDIT_GATES_ONLY` narrows the run to named gates. Without it the probe would
 * re-run every case inside the outer run, doubling a suite that already takes
 * minutes to say one thing.
 */
const EXTRA_CASES_FILE = 'quality-gates/audit-gates-extra-cases.json';
if (existsSync(EXTRA_CASES_FILE)) {
  try {
    const extra = JSON.parse(readFileSync(EXTRA_CASES_FILE, 'utf8')) as Case[];
    if (Array.isArray(extra)) CASES.push(...extra);
  } catch (err) {
    console.error(`[audit-gates] ${EXTRA_CASES_FILE} is not readable:`, (err as Error).message);
    process.exit(2);
  }
}

const ONLY = (process.env.AUDIT_GATES_ONLY ?? '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
if (ONLY.length > 0) {
  const keep = new Set(ONLY);
  for (let i = CASES.length - 1; i >= 0; i--) {
    if (!keep.has(CASES[i]!.gate)) CASES.splice(i, 1);
  }
}

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
  let output = '';
  try {
    const r = await $`sh -c ${c.cmd}`.quiet();
    output = r.stdout.toString() + r.stderr.toString();
  } catch (err) {
    failed = true;
    const e = err as { stdout?: { toString(): string }; stderr?: { toString(): string } };
    output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
  }
  if (original === null) rmSync(c.file, { force: true });
  else writeFileSync(c.file, original);

  // A non-zero exit is not enough when the case says what the refusal must say.
  // A gate that cannot run also exits non-zero — "no database to build against"
  // is a refusal to look, not a violation found — and counting that as a catch
  // is the false green this file exists to kill.
  const wrongReason = failed && c.expect !== undefined && !output.includes(c.expect);

  if (failed && !wrongReason) {
    caught++;
    console.log(`  ✅ ${c.gate.padEnd(34)} caught its violation`);
  } else if (wrongReason) {
    missed.push(c.gate);
    console.log(
      `  ❌ ${c.gate.padEnd(34)} FAILED FOR THE WRONG REASON (no ${JSON.stringify(c.expect)})`,
    );
    // Show what it DID say. Without this the report names a problem and hides
    // the only sentence that explains it, which costs a round-trip through CI
    // for every diagnosis.
    const tail = output.trim().split('\n').slice(-6).join('\n     ');
    if (tail) console.log(`     ${tail}`);
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
