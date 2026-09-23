/**
 * The permissions screen granted actions the engine never asks for.
 *
 * `GET /api/admin/resources` offered each collection `view, create, update,
 * delete`; the screen writes whatever it is offered through
 * `POST /api/admin/permissions/bulk`. The data handlers ask Casbin for `read`,
 * and the matcher compares actions exactly — so ticking "view" for a role
 * granted nothing, and every member of that role was refused 403 on a
 * collection the screen showed as readable.
 *
 * The suite drives the same three calls the screen and the role assignment
 * make, then reads the collection as a member of that role.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `permmatrix_${Date.now()}`;
const ROLE = `permmatrix_role_${Date.now()}`;

d('permission matrix actions match what the engine checks', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  let member: { cookie: string; userId: string };
  let roleId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    member = await createMemberSession(app, db, { role: 'member' });
    const res = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ name: ROLE }),
    });
    expect(res.status).toBeLessThan(300);
    roleId = ((await res.json()) as { role: { id: string } }).role.id;
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE} OR v1 = ${ROLE}`
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zv_roles')
      .where('name', '=', ROLE)
      .execute()
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('offers a collection the actions the data API checks', async () => {
    const res = await app.request('/api/admin/resources', { headers: { cookie: god } });
    const { resources } = (await res.json()) as {
      resources: Array<{ name: string; actions: string[] }>;
    };
    const mine = resources.find((r) => r.name === COLLECTION);
    expect(mine?.actions).toEqual(['read', 'create', 'update', 'delete']);
  });

  it('a role granted the offered read action can read the collection', async () => {
    const res = await app.request('/api/admin/resources', { headers: { cookie: god } });
    const { resources } = (await res.json()) as {
      resources: Array<{ name: string; actions: string[] }>;
    };
    const readAction = resources.find((r) => r.name === COLLECTION)?.actions[0];

    const bulk = await app.request('/api/admin/permissions/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        permissions: [{ role_id: roleId, resource: COLLECTION, action: readAction }],
      }),
    });
    expect(bulk.status).toBe(200);
    const assign = await app.request('/api/permissions/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ userId: member.userId, role: ROLE }),
    });
    expect(assign.status).toBeLessThan(300);

    const read = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    expect(read.status).toBe(200);
  });
});
