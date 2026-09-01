/**
 * H-12 — extension `ctx.db` is tenant-scoped.
 *
 * The last multi-tenant hole was that an extension's `ctx.db` was the GLOBAL
 * pool: a buggy (not even malicious) extension could read/write across tenants
 * by using `ctx.db` instead of `reqDb(c)`. H-12 makes `ctx.db` resolve the
 * current request/job tenant transaction via the ALS, so its queries are
 * RLS-isolated. This proves it against real Postgres.
 *
 * As with tenant-rls: CI connects as the `postgres` superuser (bypasses RLS),
 * so the data ops run under `SET LOCAL ROLE` to a non-superuser where FORCE RLS
 * binds — the engine's production posture. Requires TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';
import { applyTenantRLS } from '../../lib/tenancy/tenant-manager.js';
import { runWithDomain, runWithTenantTrx, getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import {
  createRestrictedDb,
  createDeniedAdminDb,
  ExtensionSecurityError,
} from '../../lib/extensions/extension-context.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skipAll = !TEST_DB_URL;

const TABLE = 'zvd_ctxdb_itest';
const ROLE = 'zv_ctxdb_itest_role';
const A = '00000000-0000-0000-0000-00000000aa0a';
const B = '00000000-0000-0000-0000-00000000bb0b';

let db: Database;
// The exact handle H-12 hands an extension as `ctx.db`: resolves the current
// ALS tenant transaction, else the global pool.
let ctxDb: Database;

/** Count rows visible through a Database handle (RestrictedDb-safe). */
async function count(handle: Database): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.id(TABLE)}`.execute(
    handle,
  );
  return Number(r.rows[0]?.n ?? '-1');
}

/**
 * The chain a real request takes, not a simulation of it.
 *
 * This used to call `setCurrentTenantTrx(trx)` directly — which writes the
 * transaction onto the store and leaves it there. Production does not do that.
 * `tenantMiddleware` opens a store with `runWithDomain` and then
 * `withTenantIsolation` calls `runWithTenantTrx`, and for three days that
 * function took a branch which restored the previous transaction in a
 * SYNCHRONOUS `finally` around an async callback — so it was gone before the
 * handler's first query.
 *
 * These tests passed the whole time. They asserted, faithfully, that tenant
 * isolation holds on a code path the application never executes. An audit found
 * the truth by counting rows through a live extension: 12 where the core
 * returned 11.
 *
 * So the helper now goes through `runWithTenantTrx` exactly as the middleware
 * does. Verified against the broken revision: the two cases below fail.
 */
function asTenantRequest<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  return runWithDomain(tenant, () =>
    db.transaction().execute(async (trx) => {
      await sql.raw(`SET LOCAL ROLE "${ROLE}"`).execute(trx);
      await sql`SELECT set_config('zveltio.current_tenant', ${tenant}, true)`.execute(trx);
      return runWithTenantTrx(trx as unknown as Database, tenant, fn);
    }),
  );
}

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);
  ctxDb = createRestrictedDb(() => getCurrentTenantTrx() ?? db, 'ctxdbtest', new Set([TABLE]));
  await sql.raw(`DROP TABLE IF EXISTS "${TABLE}"`).execute(db);
  await sql.raw(`DROP ROLE IF EXISTS "${ROLE}"`).execute(db);
  await sql.raw(`CREATE ROLE "${ROLE}" NOSUPERUSER`).execute(db);
  await sql
    .raw(`CREATE TABLE "${TABLE}" (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT)`)
    .execute(db);
  await sql.raw(`ALTER TABLE "${TABLE}" OWNER TO "${ROLE}"`).execute(db);
  await applyTenantRLS(db, TABLE);
  // Seed: 2 rows for A, 1 for B (tenant_id auto-tags from the GUC).
  // Insert through ctx.db itself — proving the write path is also tenant-tagged.
  await asTenantRequest(A, async () => {
    await sql.raw(`INSERT INTO "${TABLE}" (title) VALUES ('a1'), ('a2')`).execute(ctxDb);
  });
  await asTenantRequest(B, async () => {
    await sql.raw(`INSERT INTO "${TABLE}" (title) VALUES ('b1')`).execute(ctxDb);
  });
});

afterAll(async () => {
  if (skipAll || !db) return;
  await sql.raw(`DROP TABLE IF EXISTS "${TABLE}"`).execute(db);
  await sql.raw(`DROP ROLE IF EXISTS "${ROLE}"`).execute(db);
  await (db as any).destroy?.();
});

describe.skipIf(skipAll)('H-12 — extension ctx.db is tenant-scoped', () => {
  it('ctx.db under a tenant-A request sees only A’s rows', async () => {
    const n = await asTenantRequest(A, () => count(ctxDb));
    expect(n).toBe(2);
  });

  it('ctx.db under a tenant-B request sees only B’s row, never A’s', async () => {
    await asTenantRequest(B, async () => {
      expect(await count(ctxDb)).toBe(1);
      const aRows = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM ${sql.id(TABLE)} WHERE title LIKE 'a%'`.execute(ctxDb);
      expect(Number(aRows.rows[0]?.n)).toBe(0);
    });
  });

  it('ctx.db WITH CHECK: an extension cannot write a row tagged for another tenant', async () => {
    let threw = false;
    try {
      await asTenantRequest(A, async () => {
        await sql
          .raw(`INSERT INTO "${TABLE}" (title, tenant_id) VALUES ('forge', '${B}')`)
          .execute(ctxDb);
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('adminDb without the db:admin capability throws (escape hatch is gated)', () => {
    const denied = createDeniedAdminDb('ctxdbtest');
    expect(() => (denied as any).selectFrom(TABLE)).toThrow(ExtensionSecurityError);
  });
});
