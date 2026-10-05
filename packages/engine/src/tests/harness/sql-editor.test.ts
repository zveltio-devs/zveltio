/**
 * Phase C — /api/admin/sql (routes/sql-editor.ts + audit).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  DEFAULT_TENANT_ID,
  getEnforcer,
  invalidateUserPermCache,
} from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('admin SQL editor (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    db = ctx.db;
    cookie = await createGodSession(app, ctx.db);
  });

  it('POST /api/admin/sql runs a read-only query', async () => {
    const res = await app.request('/api/admin/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ query: 'SELECT 1 AS one', timeout_ms: 5000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ one: number }>; rowCount: number };
    expect(body.rowCount).toBeGreaterThanOrEqual(1);
    expect(body.rows[0]?.one).toBe(1);
  });

  it('rejects unauthenticated SQL execution', async () => {
    const res = await app.request('/api/admin/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  // God only, both modes (owner decision 2026-10-05). The default tenant's
  // admin is an instance admin, and on the pool past RLS either mode was a way
  // to god: write `UPDATE "user" SET role = 'god'`, read god's session token.
  it('refuses an instance admin who is not god, in read and in write mode', async () => {
    const { cookie: admin, userId } = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id)
              VALUES (${DEFAULT_TENANT_ID}::uuid, ${userId}) ON CONFLICT DO NOTHING`.execute(db);
    const enforcer = await getEnforcer();
    await enforcer.addRoleForUser(userId, 'tenant_admin', DEFAULT_TENANT_ID);
    await invalidateUserPermCache(userId);
    try {
      // It is an instance admin: another instance-admin route admits it.
      expect((await app.request('/api/tenants', { headers: { cookie: admin } })).status).toBe(200);
      for (const mode of ['read', 'write']) {
        const res = await app.request('/api/admin/sql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: admin },
          body: JSON.stringify({ query: 'SELECT 1', mode }),
        });
        expect(res.status).toBe(403);
      }
    } finally {
      await enforcer.deleteRoleForUser(userId, 'tenant_admin', DEFAULT_TENANT_ID);
      await invalidateUserPermCache(userId);
    }
  });
});
