/**
 * Work that holds a transaction needs one connection — the rest of #1340.
 *
 * `admin-write-one-connection.test.ts` counted the admin routes. Three shapes
 * beside them still asked the pool for a second connection while holding one:
 * a non-god admin's `POST /api/users/:id/factors/reset` (the target's god
 * lookup), the identity helpers an extension calls inside its request
 * transaction (`identity:provision`: the target's god and role lookups), and a
 * tenant purge's user deletion, whose own transaction revoked sessions and
 * wrote Casbin on the pool. At the pool size, each held every connection and
 * waited for one more until the acquire deadline.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  _setConnectionTracing,
  beginTracedTransaction,
  endTracedTransaction,
  tracedAcquisitionSite,
} from '../../db/connection-trace.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import {
  getCurrentTenantTrx,
  getEnforcer,
  grantMemberRole,
  invalidateGodCache,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { deleteTenantlessUsers } from '../../lib/users.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const S = `ioc${Date.now()}`;
const hex = S.slice(-12).padStart(12, '0');
const T = `00000000-0000-0000-0ee1-${hex}`;
const pool = Number(process.env.DB_POOL_MAX ?? '10');

/**
 * Users with no session. The insert trigger writes their `member` row and
 * `grantMemberRole` loads it into this replica's model, as sign-up's hook does.
 * (A model that has not heard of it — a user another replica just made — reads
 * the table: see `unloadedRoles`.)
 */
async function plainUsers(db: Database, n: number, tag = 'u'): Promise<string[]> {
  const ids = Array.from(
    { length: n },
    (_, i) => `${S}_${tag}${i}_${Math.random().toString(36).slice(2)}`,
  );
  for (const id of ids) {
    await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
              VALUES (${id}, ${id}, ${`${id}@test.local`}, true, NOW(), NOW(), 'member')`.execute(
      db,
    );
    await grantMemberRole(id);
    await invalidateGodCache(id);
  }
  return ids;
}

/** Extra connections `fn` took inside a transaction it holds, and where the first came from. */
async function traced(tenant: string, fn: (trx: Database) => Promise<unknown>): Promise<string> {
  let out = '';
  await withTenantIsolation(tenant, async (trx) => {
    _setConnectionTracing(true);
    beginTracedTransaction();
    try {
      await fn(trx);
    } finally {
      const extra = endTracedTransaction();
      _setConnectionTracing(false);
      out = extra === 0 ? '0' : `${extra} — ${tracedAcquisitionSite()}`;
    }
  });
  return out;
}

const burst = (n: number, one: (i: number) => Promise<unknown>) =>
  Promise.race([
    Promise.all(Array.from({ length: n }, (_, i) => one(i))).then(() => 'done'),
    Bun.sleep(15_000).then(() => 'HANG'),
  ]);

d('work that holds a transaction needs one connection', () => {
  let app: Hono;
  let db: Database;
  let ext: Database;
  const idp = gateInternals('auth/scim', buildExtensionInternals(), ['identity:provision']);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    ext = createRestrictedDb(() => getCurrentTenantTrx() ?? db, 'auth/scim', new Set());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T}::uuid, ${`ioc-${hex}`}, 'ioc', 'active')`.execute(db);
  });

  // Long enough to outlast the 35 s acquire deadline a red run leaves behind.
  afterAll(async () => {
    _setConnectionTracing(false);
    if (!db) return;
    await sql`DELETE FROM zv_tenants WHERE id = ${T}::uuid`.execute(db);
    await sql`DELETE FROM "user" WHERE id LIKE ${`${S}%`} OR email LIKE ${`${S}%`}`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 LIKE ${`${S}%`}`.execute(db);
  }, 60_000);

  it("a non-god admin's factor reset takes nothing beyond its transaction", async () => {
    const admin = await createMemberSession(app, db, {
      grants: [{ collection: 'admin', actions: ['*'] }],
    });
    const [target] = await plainUsers(db, 1);
    _setConnectionTracing(true);
    const res = await app.request(`/api/users/${target}/factors/reset`, {
      method: 'POST',
      headers: { cookie: admin.cookie },
    });
    _setConnectionTracing(false);
    const extra = res.headers.get('x-zveltio-extra-connections');
    expect(extra ? `${extra} — ${tracedAcquisitionSite()}` : '0').toBe('0');
    // Refused for want of a step-up, after the target check this counts.
    expect(res.status).toBe(403);
  }, 60_000);

  it('so do both when the target is a user this replica has not loaded', async () => {
    // Created on another replica before the bus delivered: the table holds the
    // target's `member` row, this model does not (`unloadedRoles`).
    const admin = await createMemberSession(app, db, {
      grants: [{ collection: 'admin', actions: ['*'] }],
    });
    const [target, joiner] = await plainUsers(db, 2, 'un');
    const model = (await getEnforcer()).getModel();
    const seen: Record<string, string> = {};
    try {
      for (const u of [target!, joiner!]) {
        model.removePolicy('g', 'g', [u, 'member', '*']);
        await invalidateGodCache(u);
      }
      _setConnectionTracing(true);
      const res = await app.request(`/api/users/${target}/factors/reset`, {
        method: 'POST',
        headers: { cookie: admin.cookie },
      });
      _setConnectionTracing(false);
      const extra = res.headers.get('x-zveltio-extra-connections');
      seen.reset = `${res.status} ${extra ? `${extra} — ${tracedAcquisitionSite()}` : '0'}`;
      seen.add = await traced(T, () => idp.addTenantMember(ext, joiner!));
    } finally {
      _setConnectionTracing(false);
      for (const u of [target!, joiner!]) {
        model.addPolicy('g', 'g', [u, 'member', '*']);
        await invalidateGodCache(u);
      }
    }
    expect(seen).toEqual({ reset: '403 0', add: '0' });
  }, 60_000);

  it('identity provisioning inside a transaction takes nothing beyond it', async () => {
    const [joiner, leaver, renamed, ended] = await plainUsers(db, 4, 'id');
    const seen: Record<string, string> = {};
    seen.provision = await traced(T, () => idp.provisionUser({ email: `${S}_new@test.local` }));
    seen.add = await traced(T, () => idp.addTenantMember(ext, joiner!));
    for (const u of [leaver!, renamed!, ended!]) await traced(T, () => idp.addTenantMember(ext, u));
    for (const u of [leaver!, renamed!, ended!]) await invalidateGodCache(u);
    seen.remove = await traced(T, () => idp.removeTenantMember(ext, leaver!));
    seen.rename = await traced(T, () => idp.updateUserProfile(ext, renamed!, { name: 'Renamed' }));
    seen.end = await traced(T, () => idp.setTenantMembershipEnd(ext, ended!, 'now'));
    expect(seen).toEqual({ provision: '0', add: '0', remove: '0', rename: '0', end: '0' });
  }, 60_000);

  it("a burst of tenant purges' user deletions at twice the pool size completes", async () => {
    const ids = await plainUsers(db, pool * 2, 'p');
    const requester = (await plainUsers(db, 1, 'r'))[0]!;
    const tenant = { id: T, slug: `ioc-${hex}` };
    const out = await burst(ids.length, (i) =>
      deleteTenantlessUsers(db, db, tenant, [ids[i]!], requester),
    );
    expect(out).toBe('done');
    const left = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM "user" WHERE id = ANY(${ids})`.execute(db);
    expect(left.rows[0]!.n).toBe(0);
  }, 60_000);
});
