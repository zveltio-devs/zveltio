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

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db) {
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
          { role_id: childId, resource: 'zvd_harness', action: 'read' },
          { role_id: childId, resource: 'zvd_harness', action: 'update' },
        ],
      }),
    );
    expect([200, 201]).toContain(res.status);
  });

  it('lists permissions (GET /api/admin/permissions)', async () => {
    const res = await app.request('/api/admin/permissions', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('sets a role hierarchy (POST /api/admin/roles/hierarchy)', async () => {
    const res = await app.request(
      '/api/admin/roles/hierarchy',
      json('POST', { child: CHILD, parent: PARENT }),
    );
    expect([200, 201]).toContain(res.status);
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
  });

  it('deletes a role (DELETE /api/admin/roles/:id)', async () => {
    const res = await app.request(`/api/admin/roles/${childId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
  });
});
