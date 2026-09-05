/**
 * `removeFilteredPolicy` has to honour the column the caller named.
 *
 * The adapter ignored `fieldIndex` — the parameter was named `_fieldIndex` — and
 * pinned the values to v0, v1, v2, v3 whatever the caller meant. Casbin uses the
 * index to ask questions like "every `g` rule whose SECOND column is this role",
 * which is how a role is taken away from everyone holding it. Asked that way,
 * the adapter deleted `WHERE v0 = <role>`, which normally matches nothing.
 *
 * The model updates either way, so the removal looked like it worked. Measured
 * on a live table before the fix:
 *
 *   before   table: user→role   memory: ["role"]
 *   after    table: user→role   memory: []
 *
 * Same shape as the `= NULL` comparison in `removePolicy` (#451): right in
 * memory, untouched in the database, back after the next policy load.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { getEnforcer } from '../../lib/tenancy/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('casbin adapter honours fieldIndex (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const tag = crypto.randomUUID().slice(0, 8);
  const ROLE = `fi-role-${tag}`;
  const HOLDER = `fi-user-${tag}`;
  const PARENT = `fi-parent-${tag}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    await sql`
      DELETE FROM zvd_permissions
       WHERE v0 IN (${ROLE}, ${HOLDER}) OR v1 IN (${ROLE}, ${PARENT})
    `.execute(db);
  });

  /** What the table holds, which is what survives a restart. */
  async function grouping(): Promise<string[]> {
    const r = await sql<{ v0: string; v1: string }>`
      SELECT v0, v1 FROM zvd_permissions
       WHERE ptype = 'g' AND (v0 IN (${ROLE}, ${HOLDER}) OR v1 IN (${ROLE}, ${PARENT}))
       ORDER BY v0
    `.execute(db);
    return r.rows.map((x) => `${x.v0}→${x.v1}`);
  }

  it('deletes by the second column when asked for the second column', async () => {
    const e = await getEnforcer();
    await e.addRoleForUser(HOLDER, ROLE, '*');
    expect(await grouping()).toEqual([`${HOLDER}→${ROLE}`]);

    await e.removeFilteredGroupingPolicy(1, ROLE);

    expect(await grouping()).toEqual([]);
    await e.loadPolicy();
    expect(await e.getRolesForUser(HOLDER, '*')).toEqual([]);
  });

  it('still deletes by the first column when asked for the first', async () => {
    // The direction that always worked, pinned so the fix cannot invert it.
    const e = await getEnforcer();
    await e.addRoleForUser(ROLE, PARENT, '*');
    expect(await grouping()).toEqual([`${ROLE}→${PARENT}`]);

    await e.removeFilteredGroupingPolicy(0, ROLE);
    expect(await grouping()).toEqual([]);
  });

  it('deleting a custom role takes it away from its holders', async () => {
    const e = await getEnforcer();
    const created = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: ROLE, description: 'field index probe' }),
    });
    expect(created.status).toBe(201);
    const { role } = (await created.json()) as { role: { id: string } };

    await e.addRoleForUser(HOLDER, ROLE, '*');
    expect(await grouping()).toEqual([`${HOLDER}→${ROLE}`]);

    const deleted = await app.request(`/api/admin/roles/${role.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(deleted.status).toBe(200);

    // Otherwise recreating a role with the same name silently hands it back to
    // everyone who used to hold the old one.
    expect(await grouping()).toEqual([]);
  });
});
