/**
 * Changing a user's global role must not delete their tenant memberships.
 *
 * `PATCH /api/users/:id` writes `user.role`, the global column migration 052
 * reduced to `god | member`. It also reset the caller's Casbin roles — with
 * `deleteRolesForUser(userId)` and no domain, which removes every grant the user
 * holds in every tenant. Setting somebody's column to `member` therefore stripped
 * their `tenant_owner` in one firm and their `tenant_member` in another: grants
 * this endpoint never mentions, with an audit line recording only `new_role`.
 *
 * It used not to show. The adapter's DELETE could not match a three-value grant,
 * so the removal happened in memory and the rows came back at the next policy
 * load. #451 and #455 made those deletes reach the database, which made this
 * real — a repair that changed the blast radius of a route it did not touch.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { getEnforcer } from '../../lib/tenancy/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('PATCH /api/users/:id role scope (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let userId = '';

  const tag = crypto.randomUUID().slice(0, 8);
  const TENANT_A = `scope-a-${tag}`;
  const TENANT_B = `scope-b-${tag}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    userId = `scope-user-${tag}`;
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${userId}, 'Scope Probe', ${`${userId}@test.local`}, false, 'member', NOW(), NOW())
    `.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${userId}`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${userId}`.execute(db);
  });

  it('leaves per-tenant grants alone when the global role changes', async () => {
    const e = await getEnforcer();
    await e.addRoleForUser(userId, 'tenant_owner', TENANT_A);
    await e.addRoleForUser(userId, 'tenant_member', TENANT_B);

    const res = await app.request(`/api/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(res.status).toBe(200);

    // The rows, not the model: what a restart would load.
    const rows = await sql<{ v1: string; v2: string }>`
      SELECT v1, v2 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${userId} ORDER BY v1
    `.execute(db);
    const held = rows.rows.map((r) => `${r.v1}@${r.v2}`);

    expect(held).toContain(`tenant_owner@${TENANT_A}`);
    expect(held).toContain(`tenant_member@${TENANT_B}`);
    // And the thing the route is actually for still happened.
    expect(held).toContain('member@*');
  });

  it('still replaces a previous GLOBAL grant rather than stacking one', async () => {
    // The reset exists for a reason: two global roles at once would let the
    // wider one win. Narrowing it to the '*' domain must not lose that.
    const e = await getEnforcer();
    await e.addRoleForUser(userId, 'god', '*');

    const res = await app.request(`/api/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(res.status).toBe(200);

    const rows = await sql<{ v1: string }>`
      SELECT v1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${userId} AND v2 = '*'
    `.execute(db);
    expect(rows.rows.map((r) => r.v1)).toEqual(['member']);
  });
});
