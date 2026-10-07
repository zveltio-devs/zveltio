/**
 * DELETE /api/tenants/:id?mode=purge&delete_users=true — the purged tenant's
 * members who now belong nowhere lose their account, through `deleteUser`.
 *
 * Without the flag a purge keeps every `user` row: a member of the purged
 * tenant alone could still sign in, to an account with nothing behind it.
 * With it, only that member goes — not a member of another tenant (archived
 * included), not a user of the default tenant (which has no membership row and
 * is told apart by their grants), not an instance admin, god or the requester.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getEnforcer } from '../../lib/tenancy/index.js';
import { deleteTenantlessUsers } from '../../lib/users.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const mk = (tag: string) => ({ id: crypto.randomUUID(), slug: `hpu-${tag}-${SFX}` });
const T = mk('t'); // purged with delete_users
const U = mk('u'); // another tenant, archived
const N = mk('n'); // purged without the flag
const PASSWORD = 'HarnessMember123!';

type Member = { cookie: string; userId: string; email: string };
type Users = {
  deleted: string[];
  kept: { id: string; reason: string }[];
  failed: { id: string; error: string }[];
};

d('tenant purge — delete_users', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let godId = '';
  let only: Member; // T only → deleted
  let also: Member; // T and U → kept, other_tenant
  let granted: Member; // T, plus a grant in '*' → kept, other_grants
  let roled: Member; // T, plus a ROLE in '*' (beyond the member baseline) → kept, other_grants
  let admin: Member; // T, instance admin → kept
  let onlyN: Member; // N only, purged without the flag → kept
  const keyIds = [crypto.randomUUID(), crypto.randomUUID()];

  const join = async (tenantId: string, email: string) => {
    const r = await app.request(`/api/tenants/${tenantId}/members`, {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ user_email: email, role: 'member' }),
    });
    expect(r.status).toBeLessThan(300);
  };
  const del = (id: string, q: string) =>
    app.request(`/api/tenants/${id}?${q}`, { method: 'DELETE', headers: { cookie: god } });
  const signIn = (email: string) =>
    app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
  const exists = async (id: string) =>
    (await sql`SELECT 1 FROM "user" WHERE id = ${id}`.execute(db)).rows.length === 1;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    godId = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;
    for (const t of [T, U, N]) {
      await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${t.id}, ${t.slug}, 'hpu')`.execute(
        db,
      );
    }
    only = await createMemberSession(app, db);
    also = await createMemberSession(app, db);
    granted = await createMemberSession(app, db, {
      grants: [{ collection: `hpu_${SFX}`, actions: ['read'] }],
    });
    roled = await createMemberSession(app, db);
    // Not `member`: every account holds that one, so it is nobody's grant.
    await (await getEnforcer()).addRoleForUser(roled.userId, 'employee', '*');
    admin = await createMemberSession(app, db, {
      grants: [{ collection: 'admin', actions: ['*'] }],
    });
    onlyN = await createMemberSession(app, db);
    for (const m of [only, also, granted, roled, admin]) await join(T.id, m.email);
    const godEmail = (
      await sql<{ e: string }>`SELECT email AS e FROM "user" WHERE id = ${godId}`.execute(db)
    ).rows[0]!.e;
    await join(T.id, godEmail);
    await join(U.id, also.email);
    await join(N.id, onlyN.email);

    // `only` holds keys in the default tenant and in U; T's own go with T.
    for (const [i, tenant] of [
      [0, '00000000-0000-0000-0000-000000000001'],
      [1, U.id],
    ] as const) {
      await sql`
        INSERT INTO zv_api_keys (id, name, key_hash, key_prefix, created_by, tenant_id)
        VALUES (${keyIds[i]}, 'hpu', ${`hpu-${SFX}-${i}`}, 'hpu', ${only.userId}, ${tenant})
      `.execute(db);
    }

    for (const t of [T, U, N]) expect((await del(t.id, 'mode=archive')).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE id = ANY (${keyIds})`.execute(db).catch(() => {});
    for (const t of [T, U, N]) {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${t.id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_tenants WHERE id = ${t.id}`.execute(db).catch(() => {});
    }
  });

  it('refuses delete_users that is not a boolean, and on archive', async () => {
    expect((await del(T.id, `mode=purge&confirm=${T.slug}&delete_users=yes`)).status).toBe(400);
    expect((await del(T.id, 'mode=archive&delete_users=true')).status).toBe(400);
  }, 60_000);

  it('without the flag, a purge deletes nobody', async () => {
    const res = await del(N.id, `mode=purge&confirm=${N.slug}`);
    expect(res.status).toBe(200);
    expect('users' in ((await res.json()) as object)).toBe(false);
    expect(await exists(onlyN.userId)).toBe(true);
    expect((await signIn(onlyN.email)).status).toBe(200);
  }, 60_000);

  it('deletes the member left in no tenant, and nobody else', async () => {
    expect((await app.request('/api/me', { headers: { cookie: only.cookie } })).status).toBe(200);

    const res = await del(T.id, `mode=purge&confirm=${T.slug}&delete_users=true`);
    expect(res.status).toBe(200);
    const { users } = (await res.json()) as { users: Users };
    expect(users.failed).toEqual([]);
    expect(users.deleted).toEqual([only.userId]);
    expect(Object.fromEntries(users.kept.map((k) => [k.id, k.reason]))).toEqual({
      [also.userId]: 'other_tenant',
      [granted.userId]: 'other_grants',
      // A role alone, no rule: the check on roles is what keeps this one.
      [roled.userId]: 'other_grants',
      [admin.userId]: 'instance_admin',
      [godId]: 'self',
    });

    // Gone: no row, no sign-in, no session, no working key, no grant.
    expect(await exists(only.userId)).toBe(false);
    expect((await signIn(only.email)).status).not.toBe(200);
    expect((await app.request('/api/me', { headers: { cookie: only.cookie } })).status).toBe(401);
    const sessions = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM session WHERE "userId" = ${only.userId}`.execute(db);
    expect(sessions.rows[0]?.n).toBe(0);
    const keys = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_api_keys WHERE id = ANY (${keyIds}) AND is_active`.execute(
      db,
    );
    expect(keys.rows[0]?.n).toBe(0);
    const e = await getEnforcer();
    expect(await e.getFilteredGroupingPolicy(0, only.userId)).toEqual([]);

    // Kept: rows, sign-in, and the other tenant's membership and role.
    for (const m of [also, granted, roled, admin]) {
      expect(await exists(m.userId)).toBe(true);
      expect((await signIn(m.email)).status).toBe(200);
    }
    expect(await exists(godId)).toBe(true);
    const inU = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_tenant_users WHERE tenant_id = ${U.id} AND user_id = ${also.userId}`.execute(
      db,
    );
    expect(inU.rows[0]?.n).toBe(1);
    expect(await e.getFilteredGroupingPolicy(0, also.userId, '', U.id)).toHaveLength(1);

    const audit = await sql<{ m: { deleted_users: string[] } }>`
      SELECT metadata AS m FROM zv_audit_log
       WHERE event_type = 'tenant.purged' AND resource_id = ${T.id}`.execute(db);
    expect(audit.rows[0]?.m.deleted_users).toEqual([only.userId]);
    const userAudit = await sql<{ m: { reason: string; tenant_id: string } }>`
      SELECT metadata AS m FROM zv_audit_log
       WHERE event_type = 'user.deleted' AND resource_id = ${only.userId}`.execute(db);
    expect(userAudit.rows[0]?.m).toMatchObject({ reason: 'tenant_purge', tenant_id: T.id });
  }, 60_000);

  it('keeps a god member when god is not the requester', async () => {
    // One god per instance, and the route is god-only — so through the route
    // god is always `self`. The helper is what holds when that gate moves.
    const r = await deleteTenantlessUsers(db, db, T, [godId], crypto.randomUUID());
    expect(r).toEqual({ deleted: [], kept: [{ id: godId, reason: 'god' }], failed: [] });
    expect(await exists(godId)).toBe(true);
  }, 60_000);

  it('reports a user whose deletion fails, and still deletes the next one', async () => {
    const stuck = await createMemberSession(app, db);
    const next = await createMemberSession(app, db);
    const fn = `hpu_refuse_${SFX}`;
    await sql
      .raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.id = '${stuck.userId}' THEN RAISE EXCEPTION 'hpu refused'; END IF; RETURN OLD; END $$`)
      .execute(db);
    await sql
      .raw(`CREATE TRIGGER ${fn} BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
      .execute(db);
    try {
      // Without a savepoint per user the first failure aborts the transaction
      // (25P02) and the second delete never happens.
      const r = await deleteTenantlessUsers(db, db, T, [stuck.userId, next.userId], godId);
      expect(r.deleted).toEqual([next.userId]);
      expect(r.failed.map((f) => f.id)).toEqual([stuck.userId]);
      expect(r.failed[0]?.error).toContain('hpu refused');
      expect(await exists(stuck.userId)).toBe(true);
      expect(await exists(next.userId)).toBe(false);
    } finally {
      await sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON "user"`).execute(db);
      await sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`).execute(db);
    }
  }, 60_000);
});
