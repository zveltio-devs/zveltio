/**
 * Phase C — permissions routes: the recovery-bootstrap guard, the permission
 * listing, a user's effective roles, and the cache-invalidate hook. Drives
 * routes/permissions.ts through the in-process app.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getEnforcer } from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('permissions admin (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let selfId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const row = await sql<{
      id: string;
    }>`SELECT id FROM "user" WHERE role = 'god' ORDER BY "createdAt" DESC LIMIT 1`.execute(db);
    selfId = row.rows[0]?.id ?? '';
  });

  it('refuses bootstrap when recovery mode is off (POST /bootstrap)', async () => {
    // No RECOVERY_TOKEN env in the harness → 403 (recovery disabled).
    const res = await app.request('/api/permissions/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@test.local' }),
    });
    // 403 with the recovery-disabled reason, not a generic auth refusal: the
    // route sits before the admin guard, so only its own check answers here.
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('Recovery mode is not enabled');
  });

  it('lists permissions (GET /)', async () => {
    const res = await app.request('/api/permissions', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("reads a user's roles (GET /roles/:userId)", async () => {
    // A role only this run grants, so the answer has to come from the lookup
    // and not from a default. `body.roles ?? []` used to accept a body with no
    // roles field at all.
    const role = `harness_reader_${crypto.randomUUID().slice(0, 8)}`;
    const e = await getEnforcer();
    await e.addRoleForUser(selfId, role, '*');
    try {
      const res = await app.request(`/api/permissions/roles/${selfId}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roles: string[] };
      expect(body.roles).toContain(role);
    } finally {
      await e.deleteRoleForUser(selfId, role, '*');
    }
  });

  it('invalidates the permission cache (POST /cache/invalidate)', async () => {
    const res = await app.request('/api/permissions/cache/invalidate', {
      method: 'POST',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
  });

  it('rejects unauthenticated permission listing', async () => {
    const res = await app.request('/api/permissions');
    expect(res.status).toBe(401);
  });
});
