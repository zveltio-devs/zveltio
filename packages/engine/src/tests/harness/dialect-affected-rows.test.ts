/**
 * Affected-row counts are NOT reported by this dialect. Count with RETURNING.
 *
 * Four places relied on `numUpdatedRows` / `numAffectedRows` / `numDeletedRows`,
 * and each failed differently:
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
 * One dialect behaviour, four bugs, none of which look related in review.
 * `routes/webhooks.ts` had already found it and documented the RETURNING
 * workaround locally; nothing stopped the pattern being used again elsewhere.
 *
 * This test pins the behaviour so the next person sees WHY the codebase avoids
 * these fields, instead of rediscovering it through a data-loss incident.
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

  it('reports numUpdatedRows as 0n even when rows WERE updated', async () => {
    const res = await sql.raw(`UPDATE ${T} SET v = 'y' WHERE id <= 3`).execute(db);
    const updated = await sql
      .raw<{ n: string }>(`SELECT count(*)::text AS n FROM ${T} WHERE v = 'y'`)
      .execute(db);

    // Three rows really changed…
    expect(Number(updated.rows[0]!.n)).toBe(3);
    // …and the count the driver hands back does not say so.
    const reported = (res as unknown as { numAffectedRows?: bigint }).numAffectedRows;
    expect(reported === undefined || reported === BigInt(0)).toBe(true);
  });

  it('does not populate numAffectedRows for a raw INSERT', async () => {
    const res = await sql.raw(`INSERT INTO ${T} VALUES (99, 'z')`).execute(db);
    const reported = (res as unknown as { numAffectedRows?: bigint }).numAffectedRows;
    // `?? BATCH_SIZE` and `?? 0` fall back differently on undefined, which is
    // exactly how the ghost backfill ended up looping twice and stopping.
    expect(reported).toBeUndefined();
  });

  it('RETURNING gives the true count', async () => {
    // The supported way to know. Every call site uses this now.
    const res = await sql
      .raw<{ id: number }>(`UPDATE ${T} SET v = 'w' WHERE id <= 4 RETURNING id`)
      .execute(db);
    expect(res.rows.length).toBe(4);
  });

  it('RETURNING is empty when nothing matched', async () => {
    // The property `moveToTrash` actually needed: distinguishing "no such row"
    // from "row updated", which the count could not do in either direction.
    const res = await sql
      .raw<{ id: number }>(`UPDATE ${T} SET v = 'q' WHERE id = 100000 RETURNING id`)
      .execute(db);
    expect(res.rows.length).toBe(0);
  });
});
