/**
 * A membership counts only between its `valid_from` (inclusive) and `valid_to`
 * (exclusive) — everywhere, not just in the read reach.
 *
 * `zv_tenant_users.valid_to` is how an assignment is withdrawn ("revocation is
 * a date"), and only `resolveTenantScope` read it. The membership middleware,
 * a tenant flow's role notification, the tenant broadcast audience, the
 * environments gate and the unit switcher all counted an expired or
 * not-yet-started membership as current: the person was let into the tenant
 * and reached by its messages.
 *
 * A tenant purge deliberately counts ANY row, expired included: deleting an
 * account erases its history in the other tenant (the FK cascades), so a lapsed
 * membership elsewhere still keeps the account.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const T = { id: crypto.randomUUID(), slug: `tmv-t-${TAG}` };
const X = { id: crypto.randomUUID(), slug: `tmv-x-${TAG}` }; // purged
const ROLE = `probe_tmv_${TAG}`;

type Member = { cookie: string; userId: string; email: string };

d('tenant membership validity', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let current: Member;
  let expired: Member;
  let future: Member;
  const flowIds: string[] = [];

  const enroll = (tenantId: string, userId: string, from: string, to: string | null) =>
    sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
        VALUES (${tenantId}::uuid, ${userId}, 'member', now() + ${from}::interval,
                now() + ${to}::interval)`.execute(db);
  const me = (m: Member) =>
    app.request('/api/me', { headers: { cookie: m.cookie, 'x-tenant-slug': T.slug } });

  async function notifiedByFlow(): Promise<string[]> {
    const title = `tmv-flow-${flowIds.length}-${TAG}`;
    const flow = await sql<{ id: string }>`
      INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active)
      VALUES (${T.id}, ${title}, 'manual', '{}'::jsonb, true) RETURNING id::text AS id
    `.execute(db);
    const flowId = flow.rows[0]!.id;
    flowIds.push(flowId);
    await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
      VALUES (${flowId}, 0, 'notify', 'send_notification',
              ${JSON.stringify({ role: ROLE, title, message: 'tenant secret' })}::jsonb, 'stop')
    `.execute(db);
    expect((await executeFlow(db, flowId)).status).toBe('success');
    return recipients(title);
  }

  async function recipients(title: string): Promise<string[]> {
    const rows = await sql<{ user_id: string }>`
      SELECT user_id FROM zv_notifications WHERE title = ${title} ORDER BY user_id
    `.execute(db);
    return rows.rows.map((r) => r.user_id);
  }

  const broadcast = (body: Record<string, unknown>) =>
    app.request('/api/notifications/broadcast', {
      method: 'POST',
      headers: { cookie: god, 'x-tenant-slug': T.slug, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'tenant secret', ...body }),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    for (const t of [T, X]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${t.id}::uuid, ${t.slug}, 'tmv', 'active')`.execute(db);
    }
    current = await createMemberSession(app, db);
    expired = await createMemberSession(app, db);
    future = await createMemberSession(app, db);
    await enroll(T.id, current.userId, '-1 day', null);
    await enroll(T.id, expired.userId, '-2 days', '-1 hour');
    await enroll(T.id, future.userId, '1 hour', null);
    // Both ways a role reaches a tenant flow: a grant in the tenant's own
    // domain (derived from the membership) and one at `*` (counts for members).
    for (const m of [current, expired, future]) {
      for (const dom of [T.id, '*']) {
        await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2)
                  VALUES ('g', ${m.userId}, ${ROLE}, ${dom})`.execute(db);
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    for (const id of flowIds) {
      await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flows WHERE id = ${id}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zvd_permissions WHERE v1 = ${ROLE}`.execute(db).catch(() => {});
    for (const t of [T, X]) {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${t.id}::uuid`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_tenants WHERE id = ${t.id}::uuid`.execute(db).catch(() => {});
    }
  });

  it('the membership middleware admits a current member only', async () => {
    expect((await me(current)).status).toBe(200);
    expect((await me(expired)).status).toBe(403);
    expect((await me(future)).status).toBe(403);
  });

  it("the tenant's environments and the unit switcher ignore a lapsed membership", async () => {
    const envs = (m: Member) =>
      app.request(`/api/tenants/${T.id}/environments`, { headers: { cookie: m.cookie } });
    expect((await envs(current)).status).toBe(200);
    expect((await envs(expired)).status).toBe(403);
    expect((await envs(future)).status).toBe(403);

    const units = async (m: Member) => {
      const res = await app.request('/api/tenants/me', { headers: { cookie: m.cookie } });
      expect(res.status).toBe(200);
      return ((await res.json()) as { tenants: { id: string }[] }).tenants.map((t) => t.id);
    };
    expect(await units(current)).toContain(T.id);
    expect(await units(expired)).not.toContain(T.id);
    expect(await units(future)).not.toContain(T.id);
  });

  it('a tenant flow role notification reaches the current member only', async () => {
    expect(await notifiedByFlow()).toEqual([current.userId]);
  });

  it('the tenant broadcast reaches the current member only', async () => {
    const title = `tmv-bc-${TAG}`;
    expect((await broadcast({ title })).status).toBeLessThan(300);
    expect(await recipients(title)).toEqual([current.userId]);

    const named = await broadcast({
      title: `${title}-named`,
      user_id: [expired.userId, future.userId],
    });
    expect(named.status).toBe(400);
    expect(await recipients(`${title}-named`)).toEqual([]);
  });

  it('re-adding a lapsed member through the API reopens the membership', async () => {
    const res = await app.request(`/api/tenants/${T.id}/members`, {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ user_email: expired.email, role: 'member' }),
    });
    expect(res.status).toBe(201);
    expect((await me(expired)).status).toBe(200);
    // Put it back for any test that runs after this one.
    await sql`UPDATE zv_tenant_users SET valid_to = now() - interval '1 hour'
              WHERE tenant_id = ${T.id}::uuid AND user_id = ${expired.userId}`.execute(db);
  });

  it('a purge counts every membership row, lapsed included', async () => {
    // `onlyLapsed` belonged to X once and nowhere else: X's history, deleted with X.
    // `expired` is current in X and lapsed in T: T's history keeps the account.
    const onlyLapsed = await createMemberSession(app, db);
    await enroll(X.id, onlyLapsed.userId, '-2 days', '-1 hour');
    await enroll(X.id, expired.userId, '-1 day', null);
    const del = (q: string) =>
      app.request(`/api/tenants/${X.id}?${q}`, { method: 'DELETE', headers: { cookie: god } });
    expect((await del('mode=archive')).status).toBe(200);
    const res = await del(`mode=purge&confirm=${X.slug}&delete_users=true`);
    expect(res.status).toBe(200);
    const { users } = (await res.json()) as {
      users: { deleted: string[]; kept: { id: string; reason: string }[] };
    };
    expect(users.deleted).toEqual([onlyLapsed.userId]);
    expect(users.kept).toContainEqual({ id: expired.userId, reason: 'other_tenant' });
  }, 60_000);
});
