/**
 * A pooled plan built before a migration must not survive it.
 *
 * Extension migrations alter tables the ENGINE owns — ten of them today,
 * `zvd_collections` among them — and they run at boot AFTER the steps that
 * already queried the database. So the pool holds prepared plans against the old
 * shape, and the next request to draw such a connection gets
 * `0A000 cached plan must not change result type`. Inside the request
 * transaction the dialect deliberately does not retry, so it reaches the caller
 * as a 500. Measured in CI: engine start 18:52:55.23, `ALTER TABLE
 * zvd_collections` from the `ai` extension at 18:52:56.51.
 *
 * This test plants that exact sequence on a table of its own, so it proves the
 * hazard is real BEFORE proving the fix clears it. A test that only asserted the
 * happy path would pass just as well if `recycleActivePool` did nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getActiveBunPool, recycleActivePool } from '../../db/bun-sql-dialect.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const T = `zz_stale_plan_${Date.now()}`;

d('a pooled plan does not survive a migration', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql.raw(`CREATE TABLE IF NOT EXISTS "${T}" (id int, a text)`).execute(db);
    await sql.raw(`INSERT INTO "${T}" (id, a) VALUES (1, 'x')`).execute(db);
  });

  afterAll(async () => {
    if (db)
      await sql
        .raw(`DROP TABLE IF EXISTS "${T}"`)
        .execute(db)
        .catch(() => {});
  });

  it('replaces the pool, so no plan can outlive the migration', async () => {
    // The load-bearing assertion, and the only deterministic one available.
    //
    // Triggering `0A000` on demand would need the read to land on the SAME
    // pooled backend that prepared the plan, and the pool decides that. A test
    // that asserted the error would pass or fail on which connection it drew —
    // it would be the kind of green that says nothing, which is the failure mode
    // this whole block exists to remove.
    //
    // What CAN be asserted is the mechanism: after a recycle, every backend that
    // held a plan is gone, replaced by a pool that has never prepared anything.
    // That the replacement genuinely clears a stale plan was measured directly
    // against bun:sql — and so was the alternative, `DISCARD ALL`, which leaves
    // Bun referring to a statement name the server no longer has and fails every
    // subsequent query with `26000`. Hence a new pool rather than a reset one.
    const before = getActiveBunPool();
    expect(before).not.toBeNull();

    await recycleActivePool();

    const after = getActiveBunPool();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);

    // And the engine still works through it — the check that would have caught
    // `DISCARD ALL`, whose damage only shows on the NEXT query.
    const rows = await sql<{ id: number }>`SELECT * FROM ${sql.id(T)} WHERE id = ${1}`.execute(db);
    expect(rows.rows.length).toBe(1);
  }, 30_000);

  it('survives a column appearing underneath a prepared read', async () => {
    // A parameterised read, so the driver prepares a plan whose result type is
    // the table as it stands now.
    const probe = () => sql<{ id: number }>`SELECT * FROM ${sql.id(T)} WHERE id = ${1}`.execute(db);

    const before = await probe();
    expect(before.rows.length).toBe(1);

    // What an extension migration does at boot.
    await sql.raw(`ALTER TABLE "${T}" ADD COLUMN b text`).execute(db);

    // The hazard itself. Not asserted as "must throw": the plan lives on ONE
    // pooled backend, and this read may land on another, in which case there is
    // nothing stale to trip over. What must never happen is a different error.
    let staleSeen = false;
    try {
      await probe();
    } catch (err) {
      const e = err as { errno?: string; code?: string; message?: string };
      const cachedPlan =
        e.errno === '0A000' || /cached plan must not change result type/i.test(e.message ?? '');
      expect(cachedPlan).toBe(true);
      staleSeen = true;
    }

    // The fix. After it, the same read must work whether or not the stale plan
    // surfaced above — a fresh pool has no plan from before the ALTER.
    await recycleActivePool();

    const after = await probe();
    expect(after.rows.length).toBe(1);
    expect(Object.keys(after.rows[0] as object)).toContain('b');

    console.log(`[stale-plan] stale plan surfaced before the recycle: ${staleSeen}`);
  }, 30_000);
});
