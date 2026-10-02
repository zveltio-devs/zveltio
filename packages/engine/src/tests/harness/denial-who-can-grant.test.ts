/**
 * The name in a refusal comes from the database, so it is worth checking there.
 *
 * `denialSentence` is unit-tested against hand-built input. This is the half
 * that talks to Postgres: whether the query finds the right people, ignores the
 * wrong ones, and stays quiet rather than throwing — because a refusal that
 * fails while trying to be helpful becomes a 500, and the person loses both the
 * suggestion and the answer.
 *
 * Everything below is scoped to a tenant id invented for this file, so the rows
 * cannot change what any other test sees in the shared database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { DEFAULT_TENANT_ID, describeDenial, whoCanGrant } from '../../lib/tenancy/index.js';
import { enrichDenial } from '../../middleware/enrich-denial.js';
import { tenantMiddleware } from '../../middleware/tenant.js';

const d = harnessAvailable() ? describe : describe.skip;

/** A tenant nothing else in the suite knows about. */
const TENANT = '00000000-0000-0000-0000-00000000d001';

async function makeUser(
  db: Awaited<ReturnType<typeof getTestApp>>['db'],
  name: string,
): Promise<string> {
  const id = `deny-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
    VALUES (${id}, ${name}, ${`${id}@test.local`}, false, 'member', NOW(), NOW())
  `.execute(db);
  return id;
}

async function grant(
  db: Awaited<ReturnType<typeof getTestApp>>['db'],
  userId: string,
  role: string,
  tenant: string,
): Promise<void> {
  await sql`
    INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', ${userId}, ${role}, ${tenant})
  `.execute(db);
}

d('who a refusal points at', () => {
  it('names the administrators of this tenant', async () => {
    const { db } = await getTestApp();
    const ana = await makeUser(db, 'Ana Popescu');
    const bogdan = await makeUser(db, 'Bogdan Ionescu');
    await grant(db, ana, 'tenant_admin', TENANT);
    await grant(db, bogdan, 'tenant_owner', TENANT);

    const names = (await whoCanGrant(db, TENANT)).map((g) => g.name);
    expect(names).toContain('Ana Popescu');
    expect(names).toContain('Bogdan Ionescu');
  });

  it('does not name a colleague who merely holds the resource', async () => {
    // The distinction that makes the suggestion useful rather than annoying: a
    // member with payroll access cannot give it to anyone, and sending someone
    // to them wastes two people's time.
    const { db } = await getTestApp();
    const carol = await makeUser(db, 'Carol Member');
    await grant(db, carol, 'tenant_member', TENANT);

    const names = (await whoCanGrant(db, TENANT)).map((g) => g.name);
    expect(names).not.toContain('Carol Member');
  });

  it('does not name administrators of a different tenant', async () => {
    const { db } = await getTestApp();
    const other = await makeUser(db, 'Dana OtherTenant');
    await grant(db, other, 'tenant_admin', '00000000-0000-0000-0000-00000000d999');

    const names = (await whoCanGrant(db, TENANT)).map((g) => g.name);
    expect(names).not.toContain('Dana OtherTenant');
  });

  it('caps the list, because fifteen names is not help', async () => {
    const { db } = await getTestApp();
    const many = '00000000-0000-0000-0000-00000000d002';
    for (let i = 0; i < 5; i++) {
      await grant(db, await makeUser(db, `Admin ${i}`), 'tenant_admin', many);
    }
    expect((await whoCanGrant(db, many)).length).toBeLessThanOrEqual(3);
  });

  it('separates a confidential resource from a missing grant', async () => {
    const { db } = await getTestApp();
    const secret = await describeDenial(db, 'payroll', 'read', TENANT);
    expect(secret.confidential).toBe(true);

    const ordinary = await describeDenial(db, 'contacts', 'read', TENANT);
    expect(ordinary.confidential).toBe(false);
  });

  it('returns nobody rather than throwing when the lookup cannot run', async () => {
    // Fails soft on purpose. Losing the name costs a plainer sentence; throwing
    // would turn the 403 into a 500 and lose the refusal itself.
    const broken = { executeQuery: () => Promise.reject(new Error('nope')) } as never;
    expect(await whoCanGrant(broken, TENANT)).toEqual([]);
  });
});

/**
 * A `*` grant holds in every domain, so on its own it says nothing about WHICH
 * tenant the holder works in. Naming every `*` administrator to a refused member
 * of tenant A showed them people who belong only to tenant B — a name from
 * another firm, and a pointer to someone who cannot act here. The holder counts
 * where the membership middleware would let them act: a member of the tenant
 * (`activeMembership`), or anyone in the default tenant. A grant in the tenant's
 * own domain counts unless that membership has lapsed — the same gate a flow's
 * role audience uses.
 *
 * And the tenant must be the request's. `enrichDenial` rewrites the response
 * AFTER `next()`, outside `tenantMiddleware`'s `runWithDomain`, so it has to
 * pass the tenant rather than read the async context — which there answers the
 * default tenant for every request.
 */
d('who a refusal points at, across tenants', () => {
  const TAG = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const A = '00000000-0000-0000-0000-00000000d0aa';
  const B = '00000000-0000-0000-0000-00000000d0bb';
  const slugA = `deny-a-${TAG}`;
  // Names sort the wrong people first, so the cap of three cannot hide them.
  const people = {
    starB: '000 a star, member of B only',
    starLapsed: '000 b star, A membership expired',
    domLapsed: '000 c A admin, A membership expired',
    starA: '000 d star, member of A',
    domA: '000 e A admin, member of A',
  };
  const ids: Record<keyof typeof people, string> = {} as never;
  let db: Awaited<ReturnType<typeof getTestApp>>['db'];

  const enrol = (tenant: string, user: string, lapsed = false) =>
    lapsed
      ? sql`INSERT INTO zv_tenant_users (tenant_id, user_id, valid_from, valid_to)
            VALUES (${tenant}::uuid, ${user}, now() - interval '2 days', now() - interval '1 day')`.execute(
          db,
        )
      : sql`INSERT INTO zv_tenant_users (tenant_id, user_id) VALUES (${tenant}::uuid, ${user})`.execute(
          db,
        );

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status) VALUES
                (${A}::uuid, ${slugA}, 'deny A', 'active'),
                (${B}::uuid, ${`deny-b-${TAG}`}, 'deny B', 'active')
              ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug`.execute(db);
    for (const k of Object.keys(people) as (keyof typeof people)[]) {
      ids[k] = await makeUser(db, people[k]);
    }
    await grant(db, ids.starB, 'tenant_admin', '*');
    await enrol(B, ids.starB);
    await grant(db, ids.starLapsed, 'tenant_owner', '*');
    await enrol(A, ids.starLapsed, true);
    await grant(db, ids.domLapsed, 'tenant_admin', A);
    await enrol(A, ids.domLapsed, true);
    await grant(db, ids.starA, 'tenant_admin', '*');
    await enrol(A, ids.starA);
    await grant(db, ids.domA, 'tenant_owner', A);
    await enrol(A, ids.domA);
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of Object.values(ids)) {
      await sql`DELETE FROM zvd_permissions WHERE v0 = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zv_tenants WHERE id IN (${A}::uuid, ${B}::uuid)`
      .execute(db)
      .catch(() => {});
  });

  const ours = (names: string[]) => names.filter((n) => n.startsWith('000 ')).sort();

  it('names a `*` administrator only where they are a member, and no lapsed member', async () => {
    const names = (await whoCanGrant(db, A)).map((g) => g.name);
    expect(ours(names)).toEqual([people.starA, people.domA]);
  });

  it('in the default tenant every `*` administrator is a member', async () => {
    const names = (await whoCanGrant(db, DEFAULT_TENANT_ID)).map((g) => g.name);
    expect(names).toContain(people.starB);
  });

  it('the 403 a tenant-A request gets names tenant A administrators', async () => {
    // index.ts order: enrichDenial wraps tenantMiddleware wraps the handler.
    const app = new Hono();
    app.use('*', enrichDenial(db));
    app.use('*', tenantMiddleware);
    app.get('/api/probe', (c) =>
      c.json({ code: 'permission_required', resource: 'payroll', action: 'read' }, 403),
    );
    const res = await app.request('/api/probe', { headers: { 'x-tenant-slug': slugA } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { can_grant: { name: string }[] };
    expect(ours(body.can_grant.map((g) => g.name))).toEqual([people.starA, people.domA]);
  });
});
