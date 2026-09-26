/**
 * `DELETE /api/users/:id` answers 404 for an id that is not a user — before it
 * touches anything.
 *
 * #670 made the route call `enforcer.deleteUser(id)`, which removes every `g`
 * and `p` row whose subject is `id`. The route never checked that `id` was a
 * user, and a role name sits in the same column: `DELETE /api/users/editor`
 * wiped the role's grants and its parent edge, then answered 200 and audited a
 * `user.deleted` that deleted no user.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getEnforcer } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('DELETE /api/users/:id with a role name', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let member: string;
  const tag = crypto.randomUUID().slice(0, 8);
  const ROLE = `editor_${tag}`;
  const RES = `editor_res_${tag}`;

  const rows = async () =>
    (
      await sql<{ t: string }>`
        SELECT concat_ws(',', ptype, v0, v1, v2, v3) AS t FROM zvd_permissions
         WHERE v0 = ${ROLE} OR v1 = ${ROLE}`.execute(db)
    ).rows
      .map((r) => r.t)
      .sort(); // in JS: ORDER BY follows the DB collation, and the member id is random

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    ({ userId: member } = await createMemberSession(app, db));
    const e = await getEnforcer();
    await e.addGroupingPolicy(member, ROLE, '*'); // a member
    await e.addGroupingPolicy(ROLE, 'employee', '*'); // a parent edge
    await e.addPolicy(ROLE, '*', RES, 'read');
  });

  afterAll(async () => {
    const e = await getEnforcer();
    await e.deleteRole(ROLE);
    await e.deleteUser(ROLE);
  });

  it('answers 404 and leaves the role intact', async () => {
    const before = await rows();
    expect(before).toEqual(
      [`g,${ROLE},employee,*`, `g,${member},${ROLE},*`, `p,${ROLE},*,${RES},read`].sort(),
    );

    const res = await app.request(`/api/users/${ROLE}`, { method: 'DELETE', headers: { cookie } });

    expect(await rows()).toEqual(before);
    expect(res.status).toBe(404);
    const e = await getEnforcer();
    expect(await e.getRolesForUser(ROLE, '*')).toEqual(['employee']);
    expect(await e.getFilteredPolicy(0, ROLE)).toEqual([[ROLE, '*', RES, 'read']]);
  });
});
