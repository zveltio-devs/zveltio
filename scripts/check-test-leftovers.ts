#!/usr/bin/env bun
/**
 * A test run must not leave collections behind.
 *
 * This is not tidiness. Every harness run left five collections in the database
 * it ran against, each one invisible on its own. Thirty runs during one audit
 * left 163 of them — and a measurement taken in that database reported
 * authorization at **364 ms per decision**, a figure that reached two written
 * reports before anyone asked how many collections a real install has. The
 * answer was three. On a real instance the same code cost 0,93 ms.
 *
 * So the failure this gate prevents is not a dirty database. It is a measurement
 * that lies, taken in good faith, believed, and acted on.
 *
 * Run it after a suite, against the database the suite used:
 *
 *   TEST_DATABASE_URL=… bun run scripts/check-test-leftovers.ts
 *
 * A collection created by a test is identifiable: the harness names them with a
 * `Date.now()` suffix so parallel runs do not collide. That suffix is what this
 * looks for, so a real collection an operator made is never mistaken for debris.
 */

import { SQL } from 'bun';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('[test-leftovers] FAIL — no TEST_DATABASE_URL/DATABASE_URL.');
  console.error('A gate that cannot look is not a gate that found nothing.');
  process.exit(1);
}

const sql = new SQL(url);

/** `name_1787998730666` — the timestamp suffix every harness fixture carries. */
const FIXTURE = String.raw`_\d{10,}$`;

try {
  const collections = await sql<{ name: string }[]>`
    SELECT name FROM zvd_collections WHERE name ~ ${FIXTURE} ORDER BY name
  `;

  // `_zv_old_` is Ghost DDL's post-swap copy; the boot sweep reclaims it, but a
  // test that leaves one behind is leaving a full copy of a table behind too.
  const orphans = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema()
      AND (tablename LIKE '!_zv!_old!_%' ESCAPE '!'
        OR tablename LIKE '!_zv!_changelog!_%' ESCAPE '!')
    ORDER BY tablename
  `;

  await sql.end();

  if (collections.length === 0 && orphans.length === 0) {
    console.log('[test-leftovers] OK — the suite left no collections and no ghost tables.');
    process.exit(0);
  }

  console.error('[test-leftovers] FAIL — the suite left state behind:\n');
  for (const c of collections) console.error(`  collection  ${c.name}`);
  for (const o of orphans) console.error(`  ghost table ${o.tablename}`);
  console.error('\nUse `dropTestCollection(db, name)` from `testing/app-harness.ts` in afterAll —');
  console.error('dropping the table alone leaves the row in `zvd_collections`, which is what');
  console.error('made a database accumulate 163 of these and a measurement taken there lie.');
  process.exit(1);
} catch (err) {
  await sql.end().catch(() => {});
  console.error(
    `[test-leftovers] FAIL — could not inspect the database: ${(err as Error).message}`,
  );
  process.exit(1);
}
