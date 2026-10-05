/**
 * `DELETE /api/admin/roles/:id` refuses a role the engine seeds. `employee`
 * is seeded with a zv_roles row and grants the intranet; deleting it removed
 * its grants and every holder in every tenant, and nothing seeds it again.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('DELETE /api/admin/roles/:id on a built-in role', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('refuses it and keeps its grants', async () => {
    // The harness database is shared: make sure the row exists, and compare
    // grants with what is there now rather than with a fresh install.
    await sql`INSERT INTO zv_roles (name) VALUES ('employee') ON CONFLICT (name) DO NOTHING`.execute(
      db,
    );
    const grants = async () =>
      (
        await sql`SELECT 1 FROM zvd_permissions WHERE v0 = 'employee' OR v1 = 'employee'`.execute(
          db,
        )
      ).rows.length;
    const before = await grants();
    const role = await sql<{ id: string }>`SELECT id FROM zv_roles WHERE name = 'employee'`.execute(
      db,
    );
    expect(role.rows).toHaveLength(1);
    const res = await app.request(`/api/admin/roles/${role.rows[0].id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(409);
    expect(await grants()).toBe(before);
    const row = await sql`SELECT 1 FROM zv_roles WHERE name = 'employee'`.execute(db);
    expect(row.rows).toHaveLength(1);
  });
});
