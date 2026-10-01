/**
 * Phase C — RBAC role + permission management, driven through the in-process app.
 *
 * Exercises the WRITE side of lib/tenancy/permissions.ts (Casbin policy
 * management) that the read-only checkPermission calls in the other suites never
 * reach: create role, bulk-grant permissions (addPolicy), role hierarchy
 * (addGroupingPolicy), plus the list/hierarchy reads and role deletion
 * (removePolicy). Admin-only routes under /api/admin — the harness god session
 * passes.
 *
 * Skips without a test database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const CHILD = `harness_child_${Math.floor(Math.random() * 1e6)}`;
const PARENT = `harness_parent_${Math.floor(Math.random() * 1e6)}`;

d('RBAC role + permission management (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let childId = '';
  let parentId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  const createRole = async (name: string): Promise<string> => {
    const res = await app.request('/api/admin/roles', json('POST', { name, description: name }));
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { role?: { id: string }; id?: string };
    return body.role?.id ?? body.id!;
  };

  // What GET /api/admin/permissions reports for one role, as `resource:action`.
  const grantsOf = async (roleId: string): Promise<string[]> => {
    const res = await app.request('/api/admin/permissions', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { permissions } = (await res.json()) as {
      permissions: Array<{ role_id: string; resource: string; action: string }>;
    };
    return permissions
      .filter((p) => p.role_id === roleId)
      .map((p) => `${p.resource}:${p.action}`)
      .sort();
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM zvd_permissions WHERE v0 IN (${CHILD}, ${PARENT}) OR v1 IN (${CHILD}, ${PARENT})`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_roles WHERE name IN (${CHILD}, ${PARENT})`
        .execute(db)
        .catch(() => {});
    }
  });

  it('rejects unauthenticated access to admin roles', async () => {
    const res = await app.request('/api/admin/roles');
    expect([401, 403]).toContain(res.status);
  });

  it('lists roles (GET /api/admin/roles)', async () => {
    const res = await app.request('/api/admin/roles', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('creates two roles (POST /api/admin/roles)', async () => {
    childId = await createRole(CHILD);
    parentId = await createRole(PARENT);
    expect(childId).toBeDefined();
    expect(parentId).toBeDefined();
  });

  it('rejects an invalid role name (uppercase → 400)', async () => {
    const res = await app.request('/api/admin/roles', json('POST', { name: 'BadName' }));
    expect(res.status).toBe(400);
  });

  it('bulk-grants permissions to a role (POST /api/admin/permissions/bulk)', async () => {
    const res = await app.request(
      '/api/admin/permissions/bulk',
      json('POST', {
        permissions: [
          // `view` is what the screen used to offer; the engine checks `read`.
          { role_id: childId, resource: 'zvd_harness', action: 'view' },
          { role_id: childId, resource: 'zvd_harness', action: 'update' },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await grantsOf(childId)).toEqual(['zvd_harness:read', 'zvd_harness:update']);
  });

  it('bulk REPLACES the custom-role grants rather than adding to them', async () => {
    const res = await app.request(
      '/api/admin/permissions/bulk',
      json('POST', {
        permissions: [{ role_id: childId, resource: 'zvd_harness', action: 'update' }],
      }),
    );
    expect(res.status).toBe(200);
    expect(await grantsOf(childId)).toEqual(['zvd_harness:update']);
  });

  it('sets a role hierarchy (POST /api/admin/roles/hierarchy)', async () => {
    const res = await app.request(
      '/api/admin/roles/hierarchy',
      json('POST', { child: CHILD, parent: PARENT }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a self-inheriting hierarchy (child == parent → 400)', async () => {
    const res = await app.request(
      '/api/admin/roles/hierarchy',
      json('POST', { child: CHILD, parent: CHILD }),
    );
    expect(res.status).toBe(400);
  });

  it('reads the role hierarchy (GET /api/admin/roles/hierarchy)', async () => {
    const res = await app.request('/api/admin/roles/hierarchy', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { hierarchy } = (await res.json()) as {
      hierarchy: Array<{ child: string; parent: string }>;
    };
    expect(hierarchy).toContainEqual({ child: CHILD, parent: PARENT });
  });

  it('deletes a role (DELETE /api/admin/roles/:id)', async () => {
    const res = await app.request(`/api/admin/roles/${childId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    // The role row, its grants and its inheritance edge go with it. A Casbin row
    // left behind is silently re-attached to any role later created under the
    // same name.
    const role = await db.selectFrom('zv_roles').select('id').where('id', '=', childId).execute();
    expect(role).toEqual([]);
    const rows = await sql<{ ptype: string }>`
      SELECT ptype FROM zvd_permissions WHERE v0 = ${CHILD} OR v1 = ${CHILD}
    `.execute(db);
    expect(rows.rows).toEqual([]);
  });
});
