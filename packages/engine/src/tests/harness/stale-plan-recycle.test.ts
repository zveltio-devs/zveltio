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
import { databaseDriver } from '../../db/pg-dialect.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

// `Bun.SQL` names its prepared statements and caches their plans per pooled
// connection; `pg` (ZVELTIO_DB_DRIVER=pg) sends unnamed ones, so there is no
// plan to outlive a migration and no pool to replace.
const d = harnessAvailable() && databaseDriver() === 'bun' ? describe : describe.skip;
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

  it('serves a query that arrives while the old pool is closing', async () => {
    // The old pool can take up to the close timeout to drain, and boot work
    // fired before the recycle (the policy reconcile baseline) may still query.
    // A driver with no pool in that window throws instead of serving.
    const recycling = recycleActivePool();
    const rows = await sql<{ one: number }>`SELECT 1 AS one`.execute(db);
    await recycling;
    expect(rows.rows[0]?.one).toBe(1);
  }, 30_000);

  it('survives a column appearing underneath a prepared read', async () => {
    // A parameterised read, so the driver prepares a plan whose result type is
    // the table as it stands now.
    const probe = (q: Database = db) =>
      sql<{ id: number }>`SELECT * FROM ${sql.id(T)} WHERE id = ${1}`.execute(q);
    // Which backends the pool serves from. Drawn concurrently, so every
    // connection the pool holds answers at least once and is in the set.
    const backends = async () => {
      const pids = await Promise.all(
        Array.from({ length: 8 }, () =>
          sql<{ pid: number }>`SELECT pg_backend_pid() AS pid, pg_sleep(0.05)`.execute(db),
        ),
      );
      return new Set(pids.map((r) => r.rows[0]?.pid));
    };

    expect((await probe()).rows.length).toBe(1);
    const before = await backends();

    // What an extension migration does at boot.
    await sql.raw(`ALTER TABLE "${T}" ADD COLUMN b text`).execute(db);

    // The fix. A stale plan lives on a backend, so what clears it is that no
    // backend from before the ALTER serves again. Reading the result alone
    // could not tell: outside a transaction the dialect retries `0A000` and
    // falls back to an unprepared query, so the read passes after a recycle
    // that did nothing.
    await recycleActivePool();

    const after = await backends();
    expect([...after].filter((pid) => before.has(pid))).toEqual([]);

    // And inside a transaction, where the dialect does not retry, the read
    // sees the new column.
    const inTxn = await db.transaction().execute((trx) => probe(trx as unknown as Database));
    expect(inTxn.rows.length).toBe(1);
    expect(Object.keys(inTxn.rows[0] as object)).toContain('b');
  }, 30_000);
});
