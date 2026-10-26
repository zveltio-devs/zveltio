/**
 * `PATCH /api/users/:id { role }` is god-only.
 *
 * `"user".role` is the god flag. The users router admits any instance admin, so
 * a non-god admin of the root tenant could PATCH their own row to `god`, or
 * PATCH god's row to `member` — the escalation #951 closed in the SQL editor,
 * reachable here through an ordinary route.
 *
 * God itself cannot change god status here either: the one seat (migration 008)
 * refuses a second god, and a god demoting itself by mistake left the instance
 * with none. Recovery is the only way god status moves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('PATCH /api/users/:id role is god-only (in-process)', () => {
  let app: Hono;
  let db: Database;
  let adminCookie = '';
  let adminId = '';
  let godId = '';
  let godCookie = '';

  const patch = (id: string, body: object) =>
    app.request(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify(body),
    });
  const roleOf = async (id: string) =>
    (
      await sql<{
        role: string;
      }>`SELECT role FROM "user" WHERE id = ${id}`.execute(db)
    ).rows[0]?.role;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    godId = (
      await sql<{
        id: string;
      }>`SELECT id FROM "user" WHERE role = 'god' LIMIT 1`.execute(db)
    ).rows[0]!.id;
    ({ cookie: adminCookie, userId: adminId } = await createMemberSession(app, db, {
      configWindow: true,
    }));
    // An instance admin, not a god: the role the router lets through.
    await (await getEnforcer()).addRoleForUser(adminId, 'tenant_admin', '*');
    await invalidateUserPermCache(adminId);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${adminId}`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${adminId}`.execute(db);
  });

  it('admits the admin to the router', async () => {
    expect((await patch(adminId, { name: 'Renamed admin' })).status).toBe(200);
  });

  it('refuses self-promotion to god', async () => {
    expect((await patch(adminId, { role: 'god' })).status).toBe(403);
    expect(await roleOf(adminId)).toBe('member');
  });

  it('refuses demoting god', async () => {
    expect((await patch(godId, { role: 'member' })).status).toBe(403);
    expect(await roleOf(godId)).toBe('god');
  });

  it('refuses god demoting itself, and promoting anyone', async () => {
    const asGod = (id: string, body: object) =>
      app.request(`/api/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify(body),
      });
    expect((await asGod(godId, { role: 'member' })).status).toBe(409);
    expect(await roleOf(godId)).toBe('god');
    expect((await asGod(adminId, { role: 'god' })).status).toBe(409);
    expect(await roleOf(adminId)).toBe('member');
    // A role that changes nothing about god status still goes through.
    expect((await asGod(adminId, { role: 'member' })).status).toBe(200);
  });
});
