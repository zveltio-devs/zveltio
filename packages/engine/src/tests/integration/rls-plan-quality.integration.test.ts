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

  it('leaves no RLS policy depending on a PARALLEL UNSAFE function', async () => {
    // Generic on purpose. Naming `zveltio_tenant_scope_ok` would have passed
    // while the tenancy migration beside it added twelve more functions to
    // policy quals, any one of which reintroduces the block for the whole
    // schema. `pg_depend` gives exactly the functions each policy references.
    //
    // The specific trap: `CREATE OR REPLACE FUNCTION` RESETS attributes that
    // are not restated, so a later migration redefining a marked function
    // silently unmarks it.
    const rows = await sql<{ fn: string; marker: string }>`
      SELECT DISTINCT p.proname || '(' || pg_get_function_arguments(p.oid) || ')' AS fn,
             p.proparallel AS marker
        FROM pg_depend d
        JOIN pg_proc p ON p.oid = d.refobjid AND d.refclassid = 'pg_proc'::regclass
       WHERE d.classid = 'pg_policy'::regclass
         AND p.proparallel <> 's'
    `.execute(db);
    expect(rows.rows.map((r) => r.fn)).toEqual([]);
  });

  it('leaves those functions STABLE and not SECURITY DEFINER', async () => {
    // Parallel safety is only sound because these read a GUC and nothing else.
    // If one becomes SECURITY DEFINER or VOLATILE, the marker stops being
    // defensible and inlining stops happening — so the two travel together.
    const rows = await sql<{ fn: string; provolatile: string; prosecdef: boolean }>`
      SELECT DISTINCT p.proname AS fn, p.provolatile, p.prosecdef
        FROM pg_depend d
        JOIN pg_proc p ON p.oid = d.refobjid AND d.refclassid = 'pg_proc'::regclass
       WHERE d.classid = 'pg_policy'::regclass
    `.execute(db);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect({ fn: r.fn, volatile: r.provolatile, secdef: r.prosecdef }).toEqual({
        fn: r.fn,
        volatile: 's',
        secdef: false,
      });
    }
  });

  it('never calls the visible-set function directly in a policy qual', async () => {
    // `= ANY (fn())` gives the planner nothing to estimate with — it takes the
    // index and then reads the whole table. `(SELECT fn())` makes the array an
    // InitPlan parameter, so `scalararraysel` can reach the column statistics
    // and the estimate follows the data. 406 ms against 143 ms on a full scan,
    // identical on a selective one.
    //
    // Two places write these: the migrations, and `applyTenantRLS` /
    // `reconcileExtensionTenantRLS` at run time for collection and extension
    // tables. This asserts the result rather than either source, so a new table
    // created through any path is covered.
    const rows = await sql<{ tablename: string; qual: string }>`
      SELECT tablename, qual FROM pg_policies
       WHERE schemaname = 'public'
         AND qual LIKE '%zveltio_visible_tenants%'
         AND qual NOT LIKE '%SELECT zveltio_visible_tenants%'
    `.execute(db);
    expect(rows.rows.map((r) => r.tablename)).toEqual([]);
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
