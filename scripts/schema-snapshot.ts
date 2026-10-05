#!/usr/bin/env bun
/**
 * What the database actually looks like after a real install — recorded, so a
 * change to it has to be seen.
 *
 * Every other schema gate here answers "does the code agree with the migrations".
 * None of them answer "did something that used to be true stop being true", and
 * that is the question the expensive bugs have needed.
 *
 * `zvd_translation_keys.key` was widened to `(tenant_id, key)` by engine
 * migration 036 — one of sixty unique keys repaired in the multi-tenancy
 * campaign. The table later moved to `i18n/translations`, whose own
 * `CREATE TABLE` predated that campaign and declared the narrow key. The engine
 * stopped creating the table, the extension's declaration finally applied, and
 * every new install got a per-instance unique key back: a second company could
 * not create a translation key the first had used. Nothing failed. Typecheck,
 * the contract suite, and CI were all green, because at no point did any file
 * disagree with any other file — the extension declared `UNIQUE (key)` and got
 * `UNIQUE (key)`. What was lost was the PREVIOUS state, and only a record of it
 * could have shown that.
 *
 * So this records it. Build the install, read the schema back out of the
 * catalogue, write it down, and diff. A constraint that disappears is a line
 * that disappears, in a review, with a name on it.
 *
 * WHAT IS RECORDED, and why that list:
 *   - columns, types, nullability, defaults
 *   - primary/unique/foreign-key/check constraints
 *   - UNIQUE INDEXES, which are NOT in `pg_constraint` and are easy to miss.
 *     `zv_pages` looked like it had lost uniqueness on `slug` until the indexes
 *     were read too; it had gained `(tenant_id, site_id, slug)` as an index.
 *   - row-level security: enabled, forced, and every policy expression
 *
 * RLS is in here deliberately. Two live cross-tenant holes were found in this
 * codebase by noticing a `tenant_id` column with nothing enforcing it — edge
 * functions, and the retired portal tables. A policy that vanishes is the same
 * defect arriving quietly, and it belongs in the same diff as everything else.
 *
 * Non-unique indexes are NOT recorded: they are performance, they change often,
 * and the noise would train people to approve the diff without reading it.
 *
 * Usage:
 *   bun run scripts/schema-snapshot.ts            # compare, exit 1 on drift
 *   bun run scripts/schema-snapshot.ts --write    # re-record after a change
 *
 * Needs a PostgreSQL it can create databases on (PGHOST/PGUSER/PGPASSWORD, or
 * SEAM_DATABASE_URL) and the sibling extensions checkout. Without either it
 * exits 0 with a note, because the engine repo has to be cloneable on its own.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQL } from 'bun';
import { ADMIN_URL, EXT_ROOT, ROOT, buildInstallTemplate, dbUrl } from './lib/install-template.js';
import { renderInstalledSchema as render } from '../packages/engine/src/db/installed-schema.js';

const SNAPSHOT = join(ROOT, 'packages', 'engine', 'src', 'db', 'installed-schema.snapshot.txt');
const WRITE = process.argv.includes('--write');
const DB = `zveltio_snapshot_${process.pid}`;

async function main(): Promise<void> {
  if (!existsSync(EXT_ROOT)) {
    console.log('[schema-snapshot] SKIP — no sibling zveltio-extensions checkout.');
    return;
  }
  let admin: SQL;
  try {
    admin = new SQL(ADMIN_URL);
    await admin`SELECT 1`;
  } catch (err) {
    console.log(
      `[schema-snapshot] SKIP — no database to build against (${(err as Error).message}).`,
    );
    return;
  }

  let text: string;
  let problems: string[] = [];
  try {
    problems = await buildInstallTemplate(admin, DB);
    const db = new SQL(dbUrl(DB));
    try {
      text = await render(db);
    } finally {
      await db.end();
    }
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.end();
  }

  // A migration that failed leaves a hole in the schema, and recording that hole
  // as the truth would bake the failure into the baseline.
  if (problems.length > 0) {
    console.error(
      `[schema-snapshot] ${problems.length} migration(s) failed — snapshot not trusted:`,
    );
    for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    // Separated because the two have completely different fixes and look
    // identical in the list above. A missing server-side extension is the
    // machine's problem, not the migration's: `geospatial/postgis` needs postgis,
    // which the pgvector image does not ship, and the first CI run of this job
    // failed that way and read as five broken tables.
    const missing = [
      ...new Set(
        problems.flatMap((p) =>
          [...p.matchAll(/extension "(\w+)" is not available/g)].map((m) => m[1]),
        ),
      ),
    ];
    if (missing.length > 0) {
      console.error(
        `\n  ${missing.map((m) => `"${m}"`).join(', ')} is not installed on this PostgreSQL.\n` +
          `  That is an environment gap, not a broken migration — install it and re-run.\n` +
          `  A snapshot taken without it would be missing whatever those extensions create.`,
      );
    }
    process.exit(1);
  }

  if (WRITE) {
    writeFileSync(SNAPSHOT, text);
    console.log(`[schema-snapshot] wrote ${SNAPSHOT.slice(ROOT.length + 1)}`);
    return;
  }

  if (!existsSync(SNAPSHOT)) {
    console.error('[schema-snapshot] no snapshot committed — run with --write.');
    process.exit(1);
  }
  const committed = readFileSync(SNAPSHOT, 'utf8');
  if (committed === text) {
    const n = text.split('\n').filter((l) => l.startsWith('table ')).length;
    console.log(`[schema-snapshot] OK — installed schema matches the snapshot (${n} tables).`);
    return;
  }

  const a = committed.split('\n');
  const b = text.split('\n');
  const removed = a.filter((l) => l.trim() && !b.includes(l));
  const added = b.filter((l) => l.trim() && !a.includes(l));
  console.error('\n❌ The installed schema no longer matches the committed snapshot.\n');
  if (removed.length > 0) {
    console.error(`  GONE (${removed.length}) — a constraint or policy that used to exist:`);
    for (const l of removed.slice(0, 40)) console.error(`    - ${l.trim()}`);
    if (removed.length > 40) console.error(`    … ${removed.length - 40} more`);
  }
  if (added.length > 0) {
    console.error(`\n  NEW (${added.length}):`);
    for (const l of added.slice(0, 40)) console.error(`    + ${l.trim()}`);
    if (added.length > 40) console.error(`    … ${added.length - 40} more`);
  }
  console.error(
    '\n  Read the GONE list first — that is where a silently dropped key or policy\n' +
      '  shows up. If every line is intended, re-record with:\n' +
      '    bun run scripts/schema-snapshot.ts --write\n',
  );
  process.exit(1);
}

await main();
