/**
 * The role-inheritance tree must not list user role assignments as edges.
 *
 * Casbin stores both in the same `g` rows: `POST /roles/hierarchy` writes
 * `(child_role, parent_role, '*')` and assigning a role to a user writes
 * `(user_id, role, '*')` — same ptype, same domain. `GET /roles/hierarchy` told
 * them apart with a UUID regex on v0, but better-auth ids are 32-char
 * alphanumerics, so every user assignment came back as "<user id> inherits
 * <role>". The Studio renders each with a delete button that calls
 * `DELETE /roles/hierarchy`, which revoked the user's role and audited it as a
 * hierarchy change.
 */

import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { getEnforcer } from '../../lib/tenancy/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('role hierarchy excludes user assignments (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let userId: string;

  const tag = crypto.randomUUID().slice(0, 8);
  const ROLE = `hier-user-role-${tag}`;
  const CHILD = `hier-child-${tag}`;
  const PARENT = `hier-parent-${tag}`;

  const send = (path: string, method: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    ({ userId } = await createMemberSession(app, db));
  });

  afterAll(async () => {
    await sql`
      DELETE FROM zvd_permissions WHERE v1 IN (${ROLE}, ${PARENT}) OR v0 = ${CHILD}
    `.execute(db);
  });

  it('lists the role edge and no user assignment', async () => {
    expect((await send('/api/permissions/roles', 'POST', { userId, role: ROLE })).status).toBe(200);
    expect(
      (await send('/api/admin/roles/hierarchy', 'POST', { child: CHILD, parent: PARENT })).status,
    ).toBe(200);

    const res = await app.request('/api/admin/roles/hierarchy', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { hierarchy } = (await res.json()) as {
      hierarchy: Array<{ child: string; parent: string }>;
    };

    expect(hierarchy).toContainEqual({ child: CHILD, parent: PARENT });
    const userIds = new Set(
      (await sql<{ id: string }>`SELECT id FROM "user"`.execute(db)).rows.map((r) => r.id),
    );
    expect(hierarchy.filter((e) => userIds.has(e.child))).toEqual([]);
    // Seeded `('g', 'admin', 'admin')` rows are not inheritance, and POST refuses them.
    expect(hierarchy.filter((e) => e.child === e.parent)).toEqual([]);
  });

  const count = async (child: string, parent: string) =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zvd_permissions
         WHERE ptype = 'g' AND v0 = ${child} AND v1 = ${parent}
      `.execute(db)
    ).rows[0]?.n;

  it('refuses to revoke a user assignment through the hierarchy endpoint', async () => {
    const res = await send('/api/admin/roles/hierarchy', 'DELETE', { child: userId, parent: ROLE });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('is a user, not a role');
    expect(await count(userId, ROLE)).toBe(1);
  });

  it('removes a role edge (DELETE was shadowed by DELETE /roles/:id)', async () => {
    const res = await send('/api/admin/roles/hierarchy', 'DELETE', {
      child: CHILD,
      parent: PARENT,
    });
    expect(res.status).toBe(200);
    expect(await count(CHILD, PARENT)).toBe(0);
  });

  // `GET` tells a user from a role by "v0 is a row in user". Deleting the user
  // left its `g` and `p` rows behind, so the moment the row went, its grants
  // turned into "edges" — and into rules still live in every enforcer.
  it('deleting a user takes its grants with it, so they never surface as edges', async () => {
    const gone = await createMemberSession(app, db, {
      grants: [{ collection: `hier-col-${tag}`, actions: ['read'] }],
    });
    expect(
      (await send('/api/permissions/roles', 'POST', { userId: gone.userId, role: ROLE })).status,
    ).toBe(200);

    const del = await app.request(`/api/users/${gone.userId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const left = await sql<{ ptype: string; v1: string }>`
      SELECT ptype, v1 FROM zvd_permissions WHERE v0 = ${gone.userId}
    `.execute(db);
    expect(left.rows).toEqual([]);
    const e = await getEnforcer();
    expect(await e.getNamedGroupingPolicy('g')).not.toContainEqual(
      expect.arrayContaining([gone.userId]),
    );
    expect(await e.getFilteredPolicy(0, gone.userId)).toEqual([]);

    const res = await app.request('/api/admin/roles/hierarchy', { headers: { cookie } });
    const { hierarchy } = (await res.json()) as {
      hierarchy: Array<{ child: string; parent: string }>;
    };
    expect(hierarchy.filter((edge) => edge.child === gone.userId)).toEqual([]);
  });
});
