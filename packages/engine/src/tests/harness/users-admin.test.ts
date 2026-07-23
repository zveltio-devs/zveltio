/**
 * Phase C — users admin routes: list (+ search/pagination), detail, the
 * self-delete guard, and deleting a throwaway user. Drives routes/users.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('users admin (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let selfId = '';
  let throwawayId = '';
  const throwawayEmail = `harness-throwaway-${Date.now()}@test.local`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    // Identify the god session's own user id via /me-style lookup on the list.
    const meRow = await sql<{
      id: string;
    }>`SELECT id FROM "user" WHERE role = 'god' ORDER BY "createdAt" DESC LIMIT 1`.execute(db);
    selfId = meRow.rows[0]?.id ?? '';
    // Create a throwaway user to delete.
    await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: throwawayEmail, password: 'Throwaway123!', name: 'Throwaway' }),
    });
    const row = await sql<{
      id: string;
    }>`SELECT id FROM "user" WHERE email = ${throwawayEmail}`.execute(db);
    throwawayId = row.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    if (!db) return;
    if (throwawayId)
      await sql`DELETE FROM "user" WHERE id = ${throwawayId}`.execute(db).catch(() => {});
  });

  it('lists users (GET /)', async () => {
    const res = await app.request('/api/users', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { users: unknown[] }).users.length).toBeGreaterThanOrEqual(1);
  });

  it('lists users with search + pagination', async () => {
    const res = await app.request('/api/users?search=throwaway&page=1&limit=5', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  it('reads a user detail (GET /:id)', async () => {
    const res = await app.request(`/api/users/${throwawayId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('404s an unknown user (GET /:id)', async () => {
    const res = await app.request('/api/users/nonexistent-user-id-xyz', { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('refuses to delete your own account (DELETE /:id)', async () => {
    const res = await app.request(`/api/users/${selfId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(400);
  });

  it('deletes a throwaway user (DELETE /:id)', async () => {
    const res = await app.request(`/api/users/${throwawayId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
    throwawayId = '';
  });

  it('rejects unauthenticated listing', async () => {
    const res = await app.request('/api/users');
    expect(res.status).toBe(401);
  });
});
