/**
 * A dashboard shared with a ROLE was readable and unreachable.
 *
 * `canReadDashboard` resolves the caller's roles and admits a role share —
 * that half was repaired by an earlier audit. `GET /api/insights/dashboards`
 * builds its own answer to the same question in SQL, and its share predicate
 * only ever mentioned `shared_with_user_id`. So the dashboard answered 200 on
 * GET /dashboards/:id and never appeared in the list the UI navigates by.
 *
 * Measured before the repair, with the role assigned the way POST
 * /api/users/:id/roles assigns it (`addRoleForUser(uid, role, '*')`):
 * direct GET 200, list size 0.
 *
 * Two interpreters of one rule; this suite pins them together.
 *
 * Skips without a test database.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { getEnforcer, getUserRoles, invalidateUserPermCache } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROLE = `analyst_${Date.now()}`;

d('a role-shared dashboard is listed as well as readable', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  let member: { cookie: string; userId: string };
  let dashboardId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    member = await createMemberSession(app, db, { role: 'member', grants: [] });

    const e = await getEnforcer();
    await e.addRoleForUser(member.userId, ROLE, '*');

    const mk = await app.request('/api/insights/dashboards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ name: `role-shared-${ROLE}` }),
    });
    dashboardId = (await mk.json()).dashboard.id;
  });

  it('the role assignment is the one the engine resolves', async () => {
    expect(await getUserRoles(member.userId)).toContain(ROLE);
  });

  it('is not visible before the share exists', async () => {
    const res = await app.request('/api/insights/dashboards', {
      headers: { cookie: member.cookie },
    });
    const ids = (await res.json()).dashboards.map((x: { id: string }) => x.id);
    expect(ids).not.toContain(dashboardId);
  });

  it('is readable AND listed once shared with the role', async () => {
    const share = await app.request(`/api/insights/dashboards/${dashboardId}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ shared_with_role: ROLE, permission: 'view' }),
    });
    expect(share.status).toBe(201);

    const direct = await app.request(`/api/insights/dashboards/${dashboardId}`, {
      headers: { cookie: member.cookie },
    });
    expect(direct.status).toBe(200);

    const list = await app.request('/api/insights/dashboards', {
      headers: { cookie: member.cookie },
    });
    const ids = (await list.json()).dashboards.map((x: { id: string }) => x.id);
    expect(ids).toContain(dashboardId);
  });

  it('a role the caller does not hold still does not list the dashboard', async () => {
    const other = await createMemberSession(app, db, { role: 'member', grants: [] });
    const list = await app.request('/api/insights/dashboards', {
      headers: { cookie: other.cookie },
    });
    const ids = (await list.json()).dashboards.map((x: { id: string }) => x.id);
    expect(ids).not.toContain(dashboardId);
  });
});

/**
 * Ownership of a saved query survives a demotion; the right to rewrite its SQL
 * must not.
 *
 * POST /api/insights/saved-queries requires instance admin so a low-privileged
 * user cannot park a `SELECT * FROM account` and call it back. PATCH only
 * checked ownership, so an admin who created a query and was then demoted could
 * still change the statement that /execute runs — against any table in the
 * tenant, which is more than their collection permissions allow.
 */
import { afterAll } from 'bun:test';
import { sql } from 'kysely';

const d2 = harnessAvailable() ? describe : describe.skip;

d2('a demoted owner cannot rewrite a saved query', () => {
  let app: Hono;
  let db: Database;
  let owner: { cookie: string; userId: string };
  let savedId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    // role 'member', not 'admin': the live `user_role_check` permits only
    // `god | member` (001_initial.sql narrows it again 116 lines after the
    // definition the harness helper's comment cites), so passing 'admin' fails
    // at sign-up. Instance-admin is granted as the policy requireInstanceAdmin
    // actually resolves.
    owner = await createMemberSession(app, db, { role: 'member', grants: [] });
    // Instance admin at creation time, which is what POST demands.
    // `requireInstanceAdmin` resolves to checkPermission(uid, 'admin', '*') for
    // a non-god, so grant that policy rather than writing a role name the
    // `user_role_check` constraint does not accept.
    const e = await getEnforcer();
    await e.addPolicy(owner.userId, '*', 'admin', '*');
    await invalidateUserPermCache(owner.userId);

    const create = await app.request('/api/insights/saved-queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ name: 'demote-probe', query: 'SELECT 1 AS ok' }),
    });
    savedId = (await create.json()).query.id;

    // Demoted. Still the owner.
    await e.removePolicy(owner.userId, '*', 'admin', '*');
    await invalidateUserPermCache(owner.userId);
  });

  afterAll(async () => {
    if (db && savedId) {
      await sql`DELETE FROM zvd_insight_saved_queries WHERE id = ${savedId}::uuid`
        .execute(db)
        .catch(() => {});
    }
  });

  it('may still rename it', async () => {
    const res = await app.request(`/api/insights/saved-queries/${savedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(200);
  });

  it('may not rewrite the SQL', async () => {
    const res = await app.request(`/api/insights/saved-queries/${savedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ query: 'SELECT * FROM "user"' }),
    });
    expect(res.status).toBe(403);

    const still = await app.request(`/api/insights/saved-queries/${savedId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: owner.cookie },
    });
    const body = await still.json();
    expect(JSON.stringify(body)).not.toContain('email');
  });
});
