// `ctx.internals.asSystem`: an extension acting as the system inside the tenant
// it runs as, for named collections — the way out it needs before collection
// permissions are enforced in the database (roadmap R1).
//
// What is held here: it needs `data:system`; it marks exactly the named
// collections for exactly the call, restored on success, on a throw and when
// nested; the tenant and the database role do not change inside it; it refuses
// outside a tenant's work and refuses anything that is not a collection name;
// and every call leaves an audit row naming the extension, user and collections.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionInternals } from '../../lib/extensions/internals.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const A = crypto.randomUUID();
const TAG = `assys-${A.slice(0, 8)}`;
const USER = `${TAG}-user`;
const EXT = `${TAG}-ext`;

d('ctx.internals.asSystem', () => {
  let db: Database;
  let granted: ExtensionInternals;
  let plain: ExtensionInternals;

  /** Run `fn` in tenant A's transaction, as USER, the way a request runs. */
  const inTenant = <T>(fn: (trx: Database) => Promise<T>) =>
    withTenantIsolation(A, fn, {
      identity: { userId: USER, email: '', role: 'member', roles: ['member'], bypass: false },
    });
  const mark = async (trx: Database) =>
    (
      await sql<{ v: string | null }>`
        SELECT current_setting('zveltio.system_collections', true) AS v`.execute(trx)
    ).rows[0]?.v ?? '';

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${A}::uuid, ${TAG}, ${TAG}, 'active')`.execute(db);
    await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
              VALUES (${USER}, 'u', ${`${USER}@example.test`}, true, now(), now())`.execute(db);
    granted = gateInternals(EXT, buildExtensionInternals(), ['data:system']);
    plain = gateInternals(EXT, buildExtensionInternals(), []);
  });

  afterAll(async () => {
    if (!db) return;
    await _settleAuditWrites().catch(() => undefined);
    await sql`DELETE FROM zv_audit_log WHERE tenant_id = ${A}::uuid`
      .execute(db)
      .catch(() => undefined);
    await sql`DELETE FROM "user" WHERE id = ${USER}`.execute(db).catch(() => undefined);
    await sql`DELETE FROM zv_tenants WHERE id = ${A}::uuid`.execute(db).catch(() => undefined);
  });

  it('needs the data:system capability', async () => {
    await expect(inTenant(() => plain.asSystem(['products'], async () => 1))).rejects.toThrow(
      /data:system/,
    );
  });

  it('marks the named collections for the call, in the same tenant and role', async () => {
    const seen = await inTenant(async (trx) => {
      const before = await mark(trx);
      const inside = await granted.asSystem(['products', 'orders'], async () => {
        const r = await sql<{ m: string; t: string; u: string }>`
          SELECT current_setting('zveltio.system_collections', true) AS m,
                 current_setting('zveltio.current_tenant', true) AS t,
                 current_user AS u`.execute(trx);
        return r.rows[0];
      });
      return { before, inside, after: await mark(trx) };
    });
    expect(seen.before).toBe('');
    expect(seen.inside?.m).toBe(',orders,products,');
    // System INSIDE the tenant: neither the tenant nor the role moved.
    expect(seen.inside?.t).toBe(A);
    expect(seen.inside?.u).toBe('zveltio_rls');
    expect(seen.after).toBe('');
  });

  it('restores the mark when the work throws, and when nested', async () => {
    const seen = await inTenant(async (trx) => {
      const thrown = await granted
        .asSystem(['products'], async () => {
          throw new Error('boom');
        })
        .catch((e: Error) => e.message);
      const afterThrow = await mark(trx);
      const nested = await granted.asSystem(['a_coll'], async () => {
        const inner = await granted.asSystem(['b_coll'], async () => mark(trx));
        return { inner, outer: await mark(trx) };
      });
      return { thrown, afterThrow, nested, after: await mark(trx) };
    });
    expect(seen.thrown).toBe('boom');
    expect(seen.afterThrow).toBe('');
    expect(seen.nested).toEqual({ inner: ',a_coll,b_coll,', outer: ',a_coll,' });
    expect(seen.after).toBe('');
  });

  it('refuses outside a tenant, and anything that is not a collection name', async () => {
    await expect(granted.asSystem(['products'], async () => 1)).rejects.toThrow(/inside a tenant/);
    for (const bad of [[], ['zvd_products'], ['*'], ['a,b'], ['']]) {
      await expect(
        inTenant(() => granted.asSystem(bad as string[], async () => 1)),
      ).rejects.toThrow(/collection/);
    }
  });

  it('writes an audit row naming the extension, the user and the collections', async () => {
    await inTenant(() =>
      granted.asSystem(['products'], async () => 1, { reason: 'stock decrement' }),
    );
    await _settleAuditWrites();
    // The trail is the tenant's: read it as the tenant.
    const rows = await withTenantIsolation(
      A,
      async (trx) =>
        (
          await sql<{ user_id: string; resource_id: string; metadata: Record<string, unknown> }>`
          SELECT user_id, resource_id, metadata FROM zv_audit_log
           WHERE event_type = 'extension.as_system' AND tenant_id = ${A}::uuid`.execute(trx)
        ).rows,
    );
    const row = rows.find((r) => r.metadata?.reason === 'stock decrement');
    expect(row).toBeDefined();
    expect(row?.user_id).toBe(USER);
    expect(row?.resource_id).toBe('products');
    expect(row?.metadata?.extension).toBe(`ext:${EXT}`);
    expect(row?.metadata?.collections).toEqual(['products']);
  });
});
