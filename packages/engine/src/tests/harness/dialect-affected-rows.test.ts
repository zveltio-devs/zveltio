/**
 * Affected-row counts ARE reported by this dialect. They used not to be.
 *
 * The original version of this file pinned the opposite, and it was right at the
 * time: `BunSqlSmartConnection.executeQuery` returned `{ rows }` and nothing
 * else, so Kysely had no `numAffectedRows` to build `DeleteResult` from and
 * every `numDeletedRows` / `numUpdatedRows` read as `undefined` or `0n`. Four
 * bugs came out of that, and none of them looks related in review:
 *
 *   - `moveToTrash` threw "File not found or already deleted" on every
 *     SUCCESSFUL delete. The file was trashed and the caller was told it
 *     failed — the worst shape, because a UI shows an error and the user
 *     retries something already done.
 *   - the ghost-DDL backfill copied exactly TWO batches and reported success.
 *     Its first branch fell back to `?? BATCH_SIZE` (kept looping) and its
 *     second to `?? 0` (broke immediately), so a table over 20,000 rows had its
 *     ghost swapped in incomplete. Data loss with a green log line.
 *   - the garbage collector logged and totalled zero however much it purged.
 *   - the ERD layout delete always answered `deleted: 0`.
 *
 * The fix then was to use RETURNING at each call site and write this test so
 * nobody rediscovered the behaviour through another incident. That was a
 * workaround for a missing two lines, and it only ever reached the call sites
 * somebody had already been burned by: eight handlers across four extensions
 * (`developer/api-docs`, `graphql`, `validation`, `byod`) kept the plain idiom
 * and answered 404 to deletes that had just removed the row. Measured on a live
 * instance: one row before, `DELETE` → 404 "Not found", zero rows after.
 *
 * Bun's result array carries `count` and `command` — the dialect simply was not
 * passing them on. It does now, so the whole class is gone rather than avoided,
 * and the RETURNING idiom in existing call sites keeps working untouched.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const T = `zz_affected_${Date.now()}`;

d('dialect affected-row reporting', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql.raw(`CREATE TABLE ${T} (id int primary key, v text)`).execute(db);
    await sql.raw(`INSERT INTO ${T} SELECT g, 'x' FROM generate_series(1,5) g`).execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS ${T}`)
      .execute(db)
      .catch(() => {});
  });

  it('reports the true count for an UPDATE that changed rows', async () => {
    const res = await sql.raw(`UPDATE ${T} SET v = 'y' WHERE id <= 3`).execute(db);
    const updated = await sql
      .raw<{ n: string }>(`SELECT count(*)::text AS n FROM ${T} WHERE v = 'y'`)
      .execute(db);

    expect(Number(updated.rows[0]!.n)).toBe(3);
    expect((res as unknown as { numAffectedRows?: bigint }).numAffectedRows).toBe(BigInt(3));
  });

  it('reports numDeletedRows for a DELETE that removed a row', async () => {
    // The exact shape of the extension bug: the handlers all wrote
    // `(res?.numDeletedRows ?? 0n) === 0n → 404`, so a working delete answered
    // "Not found" and the caller retried something already done.
    const res = await db
      .deleteFrom(T as never)
      .where('id' as never, '=', 5 as never)
      .executeTakeFirst();
    expect(res?.numDeletedRows).toBe(BigInt(1));
  });

  it('reports 0 when a DELETE matched nothing, so the 404 branch still works', async () => {
    // The half that must NOT change: a genuine miss still has to be
    // distinguishable from a hit, or the fix trades one wrong answer for another.
    const res = await db
      .deleteFrom(T as never)
      .where('id' as never, '=', 100000 as never)
      .executeTakeFirst();
    expect(res?.numDeletedRows).toBe(BigInt(0));
  });

  it('RETURNING still gives the true count', async () => {
    // The workaround the codebase is full of. It was never wrong, and it stays
    // correct — nothing has to be rewritten to benefit from the dialect fix.
    const res = await sql
      .raw<{ id: number }>(`UPDATE ${T} SET v = 'w' WHERE id <= 4 RETURNING id`)
      .execute(db);
    expect(res.rows.length).toBe(4);
  });

  it('RETURNING is empty when nothing matched', async () => {
    const res = await sql
      .raw<{ id: number }>(`UPDATE ${T} SET v = 'q' WHERE id = 100000 RETURNING id`)
      .execute(db);
    expect(res.rows.length).toBe(0);
  });
});
