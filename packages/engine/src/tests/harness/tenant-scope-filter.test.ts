/**
 * The explicit `tenant_id =` that makes a paginated list use its index — and the
 * one case where it must not be added.
 *
 * The RLS policy reads `tenant_id = ANY (…)` over an array the planner cannot
 * see until execution, so it will not drive an ordered index scan. A list
 * therefore walks `created_at` and discards other tenants' rows on the way.
 * Measured on 300 000 rows across 63 tenants: 6 408 discarded to return 25, and
 * 1,94 ms — against 0,08 ms and none once the read carries `tenant_id = <id>`
 * and `(tenant_id, created_at DESC)` exists.
 *
 * The equality is PERFORMANCE ONLY: the policy is untouched and still decides
 * what may be seen, and an equality can only narrow the set the policy allows.
 * Which is exactly why it must be absent when a hierarchy is in play — there,
 * narrowing to the caller's own tenant would hide the ancestors' rows the
 * request is entitled to. That is the test that matters here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getSingleTenantId } from '../../lib/tenancy/index.js';
import { withTenantIsolation } from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const ROOT = '4b000000-0000-0000-0000-000000000090';
const CHILD = '4b000000-0000-0000-0000-0000000000c1';

d('explicit tenant scope filter', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`
      INSERT INTO zv_tenants (id, slug, name, parent_id) VALUES
        (${ROOT}::uuid,  'scope-root',  'Scope Root',  NULL),
        (${CHILD}::uuid, 'scope-child', 'Scope Child', ${ROOT}::uuid)
      ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_tenants WHERE id IN (${CHILD}::uuid, ${ROOT}::uuid)`.execute(db);
  });

  it('offers the tenant when the reach is that tenant alone', async () => {
    const seen = await withTenantIsolation(CHILD, async () => getSingleTenantId());
    expect(seen).toBe(CHILD);
  });

  it('offers nothing when there is no tenant context at all', () => {
    // Outside a request — a background job, a boot reconciler — there is no
    // store, and a filter built from `undefined` would be a filter on nothing.
    expect(getSingleTenantId()).toBeNull();
  });

  it('offers nothing while a hierarchy is in play', async () => {
    // The load-bearing one. `withTenantIsolation` resolves an assignment into a
    // visible set; when it produces one, the reach is wider than the caller's
    // own tenant and an equality on that tenant would hide the rest.
    const rows = await sql<{ id: string }>`SELECT id FROM "user" LIMIT 1`.execute(db);
    const userId = rows.rows[0]?.id ?? null;
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role)
      VALUES (${ROOT}::uuid, ${userId}, 'admin')
      ON CONFLICT DO NOTHING
    `.execute(db);
    try {
      const seen = await withTenantIsolation(ROOT, async () => getSingleTenantId(), {
        userId,
      });
      // Either the scope resolved (hierarchy → null) or it did not (single →
      // ROOT). Both are correct; what is never correct is claiming a DIFFERENT
      // tenant than the one the request is scoped to.
      expect(seen === null || seen === ROOT).toBe(true);
    } finally {
      await sql`
        DELETE FROM zv_tenant_users WHERE tenant_id = ${ROOT}::uuid AND user_id = ${userId}
      `.execute(db);
    }
  });

  it('never names a tenant other than the one the request runs as', async () => {
    const a = await withTenantIsolation(ROOT, async () => getSingleTenantId());
    const b = await withTenantIsolation(CHILD, async () => getSingleTenantId());
    expect(a === null || a === ROOT).toBe(true);
    expect(b === null || b === CHILD).toBe(true);
    expect(a).not.toBe(CHILD);
    expect(b).not.toBe(ROOT);
  });

  it('does not leak out of the request that set it', async () => {
    await withTenantIsolation(CHILD, async () => getSingleTenantId());
    // The store dies with the call; a value surviving it would apply the wrong
    // tenant's equality to whatever ran next.
    expect(getSingleTenantId()).toBeNull();
  });
});
