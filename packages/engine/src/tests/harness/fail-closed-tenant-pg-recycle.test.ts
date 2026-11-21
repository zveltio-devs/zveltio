/**
 * Closing the tenant fallback reaches every connection the engine serves with,
 * on either driver (DR-03).
 *
 * `zveltio.fail_closed_tenant` is a database setting, read once when a
 * connection opens. When an operator removes `ZVELTIO_FAIL_CLOSED_TENANT=0`,
 * the boot resets the stored 'off' (`applyFailClosedTenantSetting`), but every
 * connection the boot opened before that — migrations, the schema check — still
 * carries 'off'. The boot relies on `recycleActivePool()` to drop them. On the
 * `pg` driver it only cleared a cache, so those connections stayed in the pool
 * and a query with no tenant context kept seeing the default tenant's rows.
 *
 * Driven through the harness's own primary pool, the one `recycleActivePool()`
 * renews at boot, so no second primary takes over the module-level handle the
 * worker SQL bridge reads. Runs on the pg lane only; the Bun recycle is covered
 * by stale-plan-recycle.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { recycleActivePool } from '../../db/bun-sql-dialect.js';
import { databaseDriver } from '../../db/pg-dialect.js';
import { applyFailClosedTenantSetting } from '../../lib/tenancy/fail-closed-tenant.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() && databaseDriver() === 'pg' ? describe : describe.skip;

d('the tenant fallback after a pool recycle on the pg driver', () => {
  let db: Database;
  let dbName: string;

  const visible = async () =>
    (await sql<{ v: string[] }>`SELECT zveltio_visible_tenants()::text[] AS v`.execute(db)).rows[0]!
      .v;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    dbName = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!.d;
    await sql.raw(`ALTER DATABASE "${dbName}" SET zveltio.fail_closed_tenant = 'off'`).execute(db);
    // Every pooled connection from here on opened under the opt-out.
    await recycleActivePool();
  }, 60_000);

  afterAll(async () => {
    if (!db || !dbName) return;
    await sql.raw(`ALTER DATABASE "${dbName}" RESET zveltio.fail_closed_tenant`).execute(db);
    // Later files get connections opened closed, whatever this test left.
    await recycleActivePool();
  });

  it('a connection opened under the opt-out does not outlive its removal', async () => {
    // The plant: the pool's connections opened while 'off' was stored. Without
    // the fix this already fails, for the same reason: the recycle in beforeAll
    // kept the connections opened before 'off' was stored.
    expect(await visible()).toEqual(['00000000-0000-0000-0000-000000000001']);

    const saved = process.env.ZVELTIO_FAIL_CLOSED_TENANT;
    delete process.env.ZVELTIO_FAIL_CLOSED_TENANT;
    try {
      await applyFailClosedTenantSetting(db, process.env.TEST_DATABASE_URL!);
    } finally {
      if (saved !== undefined) process.env.ZVELTIO_FAIL_CLOSED_TENANT = saved;
    }
    await recycleActivePool();

    expect(await visible()).toEqual([]);
  });
});
