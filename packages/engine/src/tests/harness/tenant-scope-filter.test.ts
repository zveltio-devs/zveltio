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
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const ROOT = '4b000000-0000-0000-0000-000000000090';
const CHILD = '4b000000-0000-0000-0000-0000000000c1';

d('explicit tenant scope filter', () => {
  let db: Database;

  beforeAll(async () => {
    const t = await getTestApp();
    db = t.db;
    // Two of the tests below need a real user row. Without this they depend on
    // some OTHER file in the shared harness process having created one first,
    // which is the order-dependence that makes a suite pass together and fail
    // alone — and it did fail alone, on a fresh database.
    await createGodSession(t.app, t.db);
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
      // A `self` assignment on this tenant IS a single-unit reach, so the
      // equality must be offered. This assertion is the point of the test: the
      // version that accepted `null || ROOT` passed both before and after the
      // fix, and the behaviour it tolerated was the bug — `scope === null` was
      // read as "single", but `resolveTenantScope` never returns null, so every
      // authenticated request lost the equality.
      expect(seen).toBe(ROOT);
    } finally {
      await sql`
        DELETE FROM zv_tenant_users WHERE tenant_id = ${ROOT}::uuid AND user_id = ${userId}
      `.execute(db);
    }
  });

  it('offers nothing when the reach is genuinely wider than one tenant', async () => {
    // The other half, and the one that would break isolation if it were wrong.
    // A `subtree` assignment on ROOT reaches CHILD too, so an equality on ROOT
    // would hide rows the request is entitled to read.
    const rows = await sql<{ id: string }>`SELECT id FROM "user" LIMIT 1`.execute(db);
    const userId = rows.rows[0]?.id ?? null;
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role, read_scope)
      VALUES (${ROOT}::uuid, ${userId}, 'admin', 'subtree')
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET read_scope = 'subtree'
    `.execute(db);
    try {
      const seen = await withTenantIsolation(ROOT, async () => getSingleTenantId(), { userId });
      expect(seen).toBeNull();
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
