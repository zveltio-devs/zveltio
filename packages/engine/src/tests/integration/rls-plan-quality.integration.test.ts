/**
 * Tenant isolation must not cost the planner its options.
 *
 * `zveltio_tenant_scope_ok` reads one GUC and compares a uuid, but a function
 * created without a parallel marker defaults to PARALLEL UNSAFE — and the
 * planner tests parallel safety BEFORE it inlines SQL functions, so the marker
 * bars parallel plans on every table the predicate protects even though the
 * function is inlined away and never called.
 *
 * Measured at 500 000 rows (median of 5): 415 ms unsafe, 204 ms safe, against a
 * 123 ms no-RLS baseline. The single-tenant self-hosted install is where it
 * bites hardest — the tenant owns every row, so a full scan is the correct plan
 * and it was the plan being denied workers.
 *
 * Requires TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';
import { applyTenantRLS } from '../../lib/tenancy/tenant-manager.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skipAll = !TEST_DB_URL;
const TABLE = 'zvd_rlsplan_itest';

let db: Database;

describe.skipIf(skipAll)('RLS predicate does not restrict the planner', () => {
  beforeAll(async () => {
    db = createDb(TEST_DB_URL as string);
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await sql.raw(`CREATE TABLE ${TABLE} (id bigserial primary key, payload text)`).execute(db);
    await applyTenantRLS(db, TABLE);
  });

  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await db.destroy();
  });

  it('marks both tenant predicate overloads PARALLEL SAFE', async () => {
    const rows = await sql<{ proname: string; proparallel: string }>`
      SELECT proname, proparallel FROM pg_proc
       WHERE proname = 'zveltio_tenant_scope_ok'
    `.execute(db);
    // Two overloads: uuid and text. Both are in RLS quals somewhere.
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows.rows) {
      // 's' = safe. 'u' (unsafe) is the default a bare CREATE FUNCTION gets,
      // and is what this test exists to stop coming back.
      expect(r.proparallel).toBe('s');
    }
  });

  it('leaves the predicate STABLE and not SECURITY DEFINER', async () => {
    // Parallel safety is only sound because the function reads a GUC and
    // nothing else. If it ever becomes SECURITY DEFINER or VOLATILE, the
    // marker above stops being defensible and inlining stops happening.
    const rows = await sql<{ provolatile: string; prosecdef: boolean }>`
      SELECT provolatile, prosecdef FROM pg_proc
       WHERE proname = 'zveltio_tenant_scope_ok'
    `.execute(db);
    for (const r of rows.rows) {
      expect(r.provolatile).toBe('s');
      expect(r.prosecdef).toBe(false);
    }
  });

  it('gives every policy-bearing table an index leading with tenant_id', async () => {
    // `applyTenantRLS` always created this; the extension reconciler beside it
    // did not, so extension tables relied on the extension having shipped one.
    // Without it the predicate can never become an Index Cond.
    const rows = await sql<{ relname: string }>`
      WITH pol AS (
        SELECT DISTINCT c.oid, c.relname
          FROM pg_policies p
          JOIN pg_class c ON c.relname = p.tablename
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE p.schemaname = 'public' AND p.policyname LIKE 'tenant\\_isolation%'
      ), lead AS (
        SELECT DISTINCT i.indrelid FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid
           AND a.attnum = i.indkey[0] AND a.attname = 'tenant_id'
      )
      SELECT relname FROM pol WHERE oid NOT IN (SELECT indrelid FROM lead)
    `.execute(db);
    expect(rows.rows.map((r) => r.relname)).toEqual([]);
  });

  it('keeps tenant isolation under a forced parallel plan', async () => {
    // The reason PARALLEL SAFE is sound: workers inherit the leader's
    // transaction-local GUC. Asserted rather than assumed, because if it were
    // false the marker would turn a performance fix into a data leak.
    const other = '22222222-2222-2222-2222-222222222222';
    await sql.raw(`INSERT INTO ${TABLE} (payload) VALUES ('own')`).execute(db);

    // The Bun SQL driver refuses a raw BEGIN on a pooled connection, and
    // SET LOCAL only means anything inside a transaction — so this has to go
    // through Kysely's transaction, which pins one connection for the block.
    const seen = await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE zveltio_rls`.execute(trx);
      await sql`SET LOCAL max_parallel_workers_per_gather = 4`.execute(trx);
      await sql`SET LOCAL parallel_setup_cost = 0`.execute(trx);
      await sql`SET LOCAL min_parallel_table_scan_size = 0`.execute(trx);
      await sql`SET LOCAL enable_indexscan = off`.execute(trx);
      await sql`SET LOCAL enable_bitmapscan = off`.execute(trx);
      await sql`SELECT set_config('zveltio.current_tenant', ${other}, true)`.execute(trx);
      const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.id(TABLE)}`.execute(
        trx,
      );
      return r.rows[0]?.n ?? -1;
    });
    expect(seen).toBe(0);
  });
});
