/**
 * What `withTenantIsolation` costs before the handler's first query, in
 * statements — and that folding the reach into the GUC write changed no answer.
 *
 * Every authenticated request pays this, single-tenant installs included. It
 * used to be a membership query, an ancestor walk, sometimes a count and an
 * org/subtree follow-up, then the `set_config` — up to five round trips, which
 * against a database 1 ms away is five milliseconds before the handler starts.
 * It is now one statement for every caller: no user, an enrolled user of any
 * reach, an expired one, and god.
 *
 * The second half pins each branch of the reach to the GUCs it publishes, so a
 * cheaper statement that resolved a different reach fails here, not in a
 * cross-tenant read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getSingleTenantId, invalidateGodCache } from '../../lib/tenancy/index.js';
import { NO_UNITS, resolveTenantScope, tenantScopeQuery } from '../../lib/tenancy/tenant-scope.js';
import { withTenantIsolation } from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const ROOT = '5c000000-0000-0000-0000-000000000090';
const KID = '5c000000-0000-0000-0000-0000000000a1';
const GRANDKID = '5c000000-0000-0000-0000-0000000000a2';
const OTHER = '5c000000-0000-0000-0000-0000000000b1';

const TAG = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const U = {
  none: `rt-none-${TAG}`,
  self: `rt-self-${TAG}`,
  list: `rt-list-${TAG}`,
  subtree: `rt-subtree-${TAG}`,
  org: `rt-org-${TAG}`,
  expired: `rt-expired-${TAG}`,
  future: `rt-future-${TAG}`,
  god: `rt-god-${TAG}`,
};

type Seen = {
  statements: number;
  visible: string;
  ancestors: string | null;
  role: string;
  single: string | null;
};

d('withTenantIsolation round trips', () => {
  let db: Database;
  let formerGods: string[] = [];
  type Execute = (this: object, q: unknown) => Promise<unknown>;
  let proto: { executeQuery: Execute } | null = null;
  let original: Execute = async () => undefined;
  const seenBy = new Map<object, number>();

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`
      INSERT INTO zv_tenants (id, slug, name, parent_id) VALUES
        (${ROOT}::uuid,     ${`rt-root-${TAG}`},  'RT Root',  NULL),
        (${KID}::uuid,      ${`rt-kid-${TAG}`},   'RT Kid',   ${ROOT}::uuid),
        (${GRANDKID}::uuid, ${`rt-gkid-${TAG}`},  'RT GKid',  ${KID}::uuid),
        (${OTHER}::uuid,    ${`rt-other-${TAG}`}, 'RT Other', NULL)
      ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id
    `.execute(db);
    for (const id of Object.values(U)) {
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        VALUES (${id}, ${id}, ${`${id}@test.invalid`}, true, 'member', now(), now())
      `.execute(db);
    }
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role, read_scope, scope_list, valid_from, valid_to) VALUES
        (${KID}::uuid, ${U.self},    'member', 'self',    NULL, now() - interval '1 day', NULL),
        (${KID}::uuid, ${U.list},    'member', 'list',
           ARRAY[${OTHER}::uuid, ${KID}::uuid], now() - interval '1 day', NULL),
        (${KID}::uuid, ${U.subtree}, 'member', 'subtree', NULL, now() - interval '1 day', NULL),
        (${KID}::uuid, ${U.org},     'member', 'org',     NULL, now() - interval '1 day', NULL),
        (${KID}::uuid, ${U.expired}, 'member', 'subtree', NULL, now() - interval '2 day', now() - interval '1 day'),
        (${KID}::uuid, ${U.future},  'member', 'org',     NULL, now() + interval '1 day', NULL)
    `.execute(db);
    // One god per instance: stand the harness god down for the god case.
    formerGods = (
      await sql<{
        id: string;
      }>`UPDATE "user" SET role = 'member' WHERE role = 'god' RETURNING id`.execute(db)
    ).rows.map((r) => r.id);
    await sql`UPDATE "user" SET role = 'god' WHERE id = ${U.god}`.execute(db);
    for (const id of [...formerGods, U.god]) await invalidateGodCache(id);

    // Count what each pooled connection executes. The transaction's connection
    // is the one `fn` is handed, so its count up to that point is exactly the
    // isolation's overhead, BEGIN included — whatever else the process runs.
    const probe = await db.getExecutor().provideConnection(async (c) => c);
    const patched = Object.getPrototypeOf(probe) as { executeQuery: Execute };
    proto = patched;
    original = patched.executeQuery;
    patched.executeQuery = function (this: object, q: unknown) {
      seenBy.set(this, (seenBy.get(this) ?? 0) + 1);
      return original.call(this, q);
    };
  });

  afterAll(async () => {
    if (proto) proto.executeQuery = original;
    if (!db) return;
    const ids = Object.values(U);
    await sql`UPDATE "user" SET role = 'member' WHERE id = ${U.god}`.execute(db);
    for (const id of formerGods) {
      await sql`UPDATE "user" SET role = 'god' WHERE id = ${id}`.execute(db);
    }
    for (const id of [...formerGods, U.god]) await invalidateGodCache(id);
    await sql`DELETE FROM zv_tenant_users WHERE user_id = ANY(${sql.val(ids)}::text[])`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ANY(${sql.val(ids)}::text[])`.execute(db);
    await sql`
      DELETE FROM zv_tenants WHERE id IN (${GRANDKID}::uuid, ${KID}::uuid, ${ROOT}::uuid, ${OTHER}::uuid)
    `.execute(db);
  });

  async function run(tenantId: string, userId: string | null): Promise<Seen> {
    return withTenantIsolation(
      tenantId,
      async (trx) => {
        const conn = await trx.getExecutor().provideConnection(async (c) => c);
        // BEGIN is one of them; the rest is what the isolation added.
        const statements = (seenBy.get(conn) ?? 0) - 1;
        // `ancestor_tenants` is read only to prove nothing publishes it (078).
        const r = await sql<{ visible: string; ancestors: string | null; role: string }>`
          SELECT current_setting('zveltio.visible_tenants', true) AS visible,
                 nullif(current_setting('zveltio.ancestor_tenants', true), '') AS ancestors,
                 current_user::text AS role
        `.execute(trx);
        const row = r.rows[0]!;
        return { statements, ...row, single: getSingleTenantId() };
      },
      { userId },
    );
  }

  const set = (csv: string) => csv.split(',').filter(Boolean).sort();
  const tenantCount = async () =>
    Number(
      (await sql<{ n: number }>`SELECT count(*)::int AS n FROM zv_tenants`.execute(db)).rows[0]!.n,
    );

  it('costs one statement for every caller, whatever the reach', async () => {
    for (const userId of [null, ...Object.values(U)]) {
      const seen = await run(KID, userId);
      expect({ userId, statements: seen.statements }).toEqual({ userId, statements: 1 });
    }
  });

  it('no user: no set, single-unit reach', async () => {
    const s = await run(KID, null);
    expect(s.visible).toBe('');
    expect(s.single).toBe(KID);
  });

  it('a user with no assignment publishes no set', async () => {
    const s = await run(KID, U.none);
    expect(s.visible).toBe('');
    expect(s.single).toBe(KID);
  });

  it('self is the unit alone', async () => {
    const s = await run(KID, U.self);
    expect(s.visible).toBe(KID);
    expect(s.single).toBe(KID);
  });

  it('no caller gets an ancestor set, and the reach walks no ancestors (078)', async () => {
    // KID has ROOT above it. Until 078 every request walked up to it and
    // published `zveltio.ancestor_tenants`, which no policy read.
    for (const userId of [null, ...Object.values(U)]) {
      expect({ userId, ancestors: (await run(KID, userId)).ancestors }).toEqual({
        userId,
        ancestors: null,
      });
    }
    const r = await sql<{ ancestors_csv: string | null }>`
      SELECT r.ancestors_csv FROM zveltio_tenant_reach(${U.self}, ${KID}) AS r
    `.execute(db);
    expect(r.rows[0]?.ancestors_csv).toBeNull();
  });

  it('list is the unit plus the list, the unit first and once', async () => {
    const s = await run(KID, U.list);
    expect(s.visible).toBe(`${KID},${OTHER}`);
    expect(s.single).toBeNull();
  });

  it('subtree is the unit and everything under it', async () => {
    const s = await run(KID, U.subtree);
    expect(set(s.visible)).toEqual([KID, GRANDKID].sort());
    expect(s.visible.split(',')[0]).toBe(KID);
    expect(s.single).toBeNull();
    const g = await run(GRANDKID, U.subtree);
    // The assignment is on KID, not on GRANDKID: no reach there at all.
    expect(g.visible).toBe('');
  });

  it('org is every unit', async () => {
    const s = await run(KID, U.org);
    expect(set(s.visible)).toHaveLength(await tenantCount());
    expect(set(s.visible)).toEqual(expect.arrayContaining([ROOT, KID, GRANDKID, OTHER]));
  });

  it('an expired or not-yet-started assignment sees nothing', async () => {
    for (const userId of [U.expired, U.future]) {
      const s = await run(KID, userId);
      expect(s.visible).toBe(NO_UNITS);
      expect(s.single).toBeNull();
    }
  });

  it('an assignment whose valid_to passes is excluded on the very next request', async () => {
    await sql`
      UPDATE zv_tenant_users SET valid_to = now() + interval '1 second'
       WHERE user_id = ${U.self} AND tenant_id = ${KID}::uuid
    `.execute(db);
    try {
      expect((await run(KID, U.self)).visible).toBe(KID);
      await Bun.sleep(1100);
      expect((await run(KID, U.self)).visible).toBe(NO_UNITS);
    } finally {
      await sql`
        UPDATE zv_tenant_users SET valid_to = NULL
         WHERE user_id = ${U.self} AND tenant_id = ${KID}::uuid
      `.execute(db);
    }
  });

  it('god sees every unit', async () => {
    const s = await run(KID, U.god);
    expect(set(s.visible)).toHaveLength(await tenantCount());
  });

  it('the role is dropped AFTER the reach is read, in the same statement', async () => {
    const hasRole = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_rls') AS ok
    `.execute(db);
    const s = await run(KID, U.subtree);
    if (!hasRole.rows[0]!.ok) return;
    expect(s.role).toBe('zveltio_rls');
    expect(set(s.visible)).toEqual([KID, GRANDKID].sort());

    // The restricted role holds SELECT on `zv_tenants` today, so the line above
    // cannot tell the orders apart. Take the grant away — inside a transaction
    // that is rolled back — and the subtree walk must still answer in full.
    const walked = await db
      .transaction()
      .execute(async (trx) => {
        await sql`REVOKE SELECT ON zv_tenants FROM zveltio_rls`.execute(trx);
        const r = await sql<{ visible_csv: string; who: string }>`
          WITH reach AS MATERIALIZED (${tenantScopeQuery(U.subtree, KID)})
          SELECT reach.visible_csv,
                 set_config('role', 'zveltio_rls', true) AS who
            FROM reach
        `.execute(trx);
        throw Object.assign(new Error('rollback'), { row: r.rows[0] });
      })
      .catch((e: { row?: { visible_csv: string; who: string } }) => e.row);
    expect(walked?.who).toBe('zveltio_rls');
    expect(set(walked?.visible_csv ?? '')).toEqual([KID, GRANDKID].sort());
  });

  it('a temporary zv_tenant_users on the connection does not answer the reach', async () => {
    // pg_temp is searched FIRST for relations unless a path names it, so before
    // migration 069 a temp table left on a pooled backend (by any role still
    // holding TEMPORARY) answered the next borrower's reach — here widening a
    // `self` member to every unit. Rolled back with the transaction.
    const visible = await db
      .transaction()
      .execute(async (trx) => {
        await sql`CREATE TEMP TABLE zv_tenant_users (LIKE public.zv_tenant_users) ON COMMIT DROP`.execute(
          trx,
        );
        await sql`
          INSERT INTO zv_tenant_users (id, tenant_id, user_id, role, joined_at, read_scope, valid_from)
          VALUES (gen_random_uuid(), ${KID}::uuid, ${U.self}, 'member', now(), 'org', now() - interval '1 day')
        `.execute(trx);
        const r = await tenantScopeQuery(U.self, KID).execute(trx);
        throw Object.assign(new Error('rollback'), { visible: r.rows[0]?.visible_csv });
      })
      .catch((e: { visible?: string | null }) => e.visible);
    expect(visible).toBe(KID);
  });

  it('resolveTenantScope answers what withTenantIsolation publishes', async () => {
    for (const userId of [U.none, U.self, U.list, U.subtree, U.expired]) {
      const scope = await resolveTenantScope(db, userId, KID);
      const s = await run(KID, userId);
      expect((scope.visible ?? []).join(',')).toBe(s.visible);
    }
  });
});
