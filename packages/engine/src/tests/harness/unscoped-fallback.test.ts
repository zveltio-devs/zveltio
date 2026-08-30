/**
 * A real request must never reach the unscoped pool.
 *
 * `createRequestScopedDb` resolves `getCurrentTenantTrx() ?? pool`. That `??` is
 * the quietest failure in the engine: with no transaction open, a
 * `db.selectFrom(...)` runs on the raw pool as the engine's own role, so a
 * tenant-scoped read returns every tenant's rows and nothing throws or logs.
 *
 * The fallback is not itself wrong — boot code holds this handle with no request
 * around it. What was missing is any way to tell the two apart, which is why
 * "open the transaction later instead of for the whole request" has never been a
 * small change: getting it wrong is invisible. Measured before this existed, the
 * concurrency ceiling sits exactly at DB_POOL_MAX because that transaction pins
 * a connection for the request's whole life.
 *
 * So this drives real routes through the real app and asserts the count stays at
 * zero. It is the precondition for Block A, not the refactor itself.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { sql } from 'kysely';
import {
  getUnscopedFallbackCount,
  resetUnscopedFallbackCount,
  setTenantScopedTables,
} from '../../lib/tenancy/tenant-context.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('a request never reaches the unscoped pool', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    // The harness builds the app in-process and does not run the engine's boot
    // sequence, so it populates this itself — from the same query, so the test
    // measures the same set production does rather than a list kept beside it.
    const rows = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name = 'tenant_id'
    `.execute(db);
    setTenantScopedTables(rows.rows.map((r) => r.table_name));
  });

  it('serves reads and writes without one unscoped fallback', async () => {
    // After boot: startup reconcilers legitimately hold this handle outside any
    // request, so the count is only meaningful from here on.
    resetUnscopedFallbackCount();

    for (const path of ['/api/collections', '/api/me', '/api/tenants']) {
      const res = await app.request(path, { headers: { cookie } });
      // Not asserting 200: a route may legitimately 403 or 404 in this fixture.
      // What matters is that whatever it did, it did inside a transaction.
      expect(res.status).toBeLessThan(500);
    }

    expect(getUnscopedFallbackCount()).toBe(0);
  }, 60_000);

  it('counts the fallback when there is genuinely no transaction', async () => {
    // The other direction, so a zero above cannot be a counter that never moves.
    // This is the shape the counter exists to catch, produced on purpose.
    const { createRequestScopedDb } = await import('../../lib/tenancy/tenant-context.js');
    resetUnscopedFallbackCount();
    const scoped = createRequestScopedDb(db);
    // Outside any `withTenantIsolation`, so there is no ambient transaction.
    // A TENANT-SCOPED table, deliberately. `zvd_collections` is shared, so it
    // would count nothing — which is the distinction the first version of this
    // counter lacked.
    void scoped.selectFrom('zvd_webhooks');
    expect(getUnscopedFallbackCount()).toBe(1);
    resetUnscopedFallbackCount();
  }, 60_000);
});
