/**
 * Cross-tenant isolation gate (beta.18 enforcement).
 *
 * Exercises the REAL `applyTenantRLS` against Postgres and proves a collection
 * table is row-isolated by the `zveltio.current_tenant` GUC. CI connects as the
 * `postgres` superuser, which BYPASSES RLS — so the test runs the data ops under
 * `SET LOCAL ROLE` to a non-superuser (exactly the role the engine should use in
 * production), where FORCE RLS binds.
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

const TABLE = 'zvd_rls_itest';
const ROLE = 'zv_rls_itest_role';
const A = '00000000-0000-0000-0000-0000000a000a';
const B = '00000000-0000-0000-0000-0000000b000b';

let db: Database;

// Run a unit of work as the non-superuser role with a tenant GUC set, so FORCE
// RLS is enforced (the engine's production posture).
function asTenant<T>(tenant: string, fn: (trx: Database) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL ROLE "${ROLE}"`).execute(trx);
    await sql`SELECT set_config('zveltio.current_tenant', ${tenant}, true)`.execute(trx);
    return fn(trx as unknown as Database);
  });
}

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);
  await sql.raw(`DROP TABLE IF EXISTS "${TABLE}"`).execute(db);
  await sql.raw(`DROP ROLE IF EXISTS "${ROLE}"`).execute(db);
  await sql.raw(`CREATE ROLE "${ROLE}" NOSUPERUSER`).execute(db);
  await sql
    .raw(`CREATE TABLE "${TABLE}" (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT)`)
    .execute(db);
  // Engine connects as a non-superuser owner in production — replicate that.
  await sql.raw(`ALTER TABLE "${TABLE}" OWNER TO "${ROLE}"`).execute(db);
  await applyTenantRLS(db, TABLE);
});

afterAll(async () => {
  if (skipAll || !db) return;
  await sql.raw(`DROP TABLE IF EXISTS "${TABLE}"`).execute(db);
  await sql.raw(`DROP ROLE IF EXISTS "${ROLE}"`).execute(db);
  await (db as any).destroy?.();
});

describe.skipIf(skipAll)('Tenant RLS — cross-tenant isolation', () => {
  it('tenant A only sees its own rows (tenant_id auto-tagged from the GUC)', async () => {
    await asTenant(A, async (trx) => {
      await sql.raw(`INSERT INTO "${TABLE}" (title) VALUES ('a1'), ('a2')`).execute(trx);
      const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.id(TABLE)}`.execute(
        trx,
      );
      expect(r.rows[0]?.n).toBe('2');
    });
  });

  it('tenant B sees only its row, never tenant A’s', async () => {
    await asTenant(B, async (trx) => {
      await sql.raw(`INSERT INTO "${TABLE}" (title) VALUES ('b1')`).execute(trx);
      const total = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM ${sql.id(TABLE)}`.execute(trx);
      expect(total.rows[0]?.n).toBe('1');
      const aRows = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM ${sql.id(TABLE)} WHERE title LIKE 'a%'`.execute(trx);
      expect(aRows.rows[0]?.n).toBe('0');
    });
  });

  it('tenant A still sees exactly its 2 rows after B wrote', async () => {
    await asTenant(A, async (trx) => {
      const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.id(TABLE)}`.execute(
        trx,
      );
      expect(r.rows[0]?.n).toBe('2');
    });
  });

  it('no tenant GUC → zero rows (FORCE RLS denies background reads without context)', async () => {
    const r = await db.transaction().execute(async (trx) => {
      await sql.raw(`SET LOCAL ROLE "${ROLE}"`).execute(trx);
      return sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.id(TABLE)}`.execute(trx);
    });
    expect(r.rows[0]?.n).toBe('0');
  });

  it('WITH CHECK: tenant A cannot forge a row tagged as tenant B', async () => {
    let threw = false;
    try {
      await asTenant(A, async (trx) => {
        await sql
          .raw(`INSERT INTO "${TABLE}" (title, tenant_id) VALUES ('forge', '${B}')`)
          .execute(trx);
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
