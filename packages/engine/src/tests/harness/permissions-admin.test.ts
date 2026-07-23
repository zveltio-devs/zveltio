/**
 * Phase C — permissions routes: the recovery-bootstrap guard, the permission
 * listing, a user's effective roles, and the cache-invalidate hook. Drives
 * routes/permissions.ts through the in-process app.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
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
    expect([401, 403]).toContain(res.status);
  });

  it('lists permissions (GET /)', async () => {
    const res = await app.request('/api/permissions', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("reads a user's roles (GET /roles/:userId)", async () => {
    const res = await app.request(`/api/permissions/roles/${selfId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles?: unknown[] };
    expect(Array.isArray(body.roles ?? [])).toBe(true);
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
