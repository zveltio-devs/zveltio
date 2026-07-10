/**
 * Phase C — /api/notifications routes driven through the in-process app.
 *
 * Exercises routes/notifications.ts: list, mark read/unread, mark-all-read,
 * push-tokens, and admin broadcast. Uses the god harness session.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('notifications API (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let userId = '';
  let notificationId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const row = await sql<{
      id: string;
    }>`SELECT id FROM "user" WHERE role = 'god' ORDER BY "createdAt" DESC LIMIT 1`.execute(db);
    userId = row.rows[0]!.id;
  });

  afterAll(async () => {
    if (db && notificationId) {
      await sql`DELETE FROM zv_notifications WHERE id = ${notificationId}`
        .execute(db)
        .catch(() => {});
    }
  });

  it('rejects unauthenticated listing', async () => {
    const res = await app.request('/api/notifications');
    expect(res.status).toBe(401);
  });

  it('lists notifications for the current user', async () => {
    const res = await app.request('/api/notifications', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: unknown[]; stats: { total: number } };
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(typeof body.stats.total).toBe('number');
  });

  it('admin broadcast creates a notification', async () => {
    const res = await app.request(
      '/api/notifications/broadcast',
      json('POST', {
        user_id: userId,
        title: 'Harness broadcast',
        message: 'Hello from harness',
        type: 'info',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; sent_to: number };
    expect(body.success).toBe(true);
    expect(body.sent_to).toBeGreaterThanOrEqual(1);

    const list = await app.request('/api/notifications?unread_only=true', { headers: { cookie } });
    const listed = (await list.json()) as { notifications: { id: string; title: string }[] };
    const hit = listed.notifications.find((n) => n.title === 'Harness broadcast');
    expect(hit).toBeDefined();
    notificationId = hit!.id;
  });

  it('marks a notification as read then unread', async () => {
    expect(notificationId.length).toBeGreaterThan(0);

    const read = await app.request(`/api/notifications/${notificationId}/read`, {
      method: 'PATCH',
      headers: { cookie },
    });
    expect(read.status).toBe(200);

    const unread = await app.request(`/api/notifications/${notificationId}/unread`, {
      method: 'PATCH',
      headers: { cookie },
    });
    expect(unread.status).toBe(200);
  });

  it('mark-all-read succeeds', async () => {
    const res = await app.request('/api/notifications/mark-all-read', json('POST', {}));
    expect(res.status).toBe(200);
  });

  it('lists push tokens (empty ok)', async () => {
    const res = await app.request('/api/notifications/push-tokens', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: unknown[] };
    expect(Array.isArray(body.tokens)).toBe(true);
  });

  it('registers and deletes a push token', async () => {
    const reg = await app.request(
      '/api/notifications/push-tokens',
      json('POST', { token: 'tok-harness-1', platform: 'web', device_name: 'test' }),
    );
    expect(reg.status).toBe(200);

    const list = await app.request('/api/notifications/push-tokens', { headers: { cookie } });
    const body = (await list.json()) as { tokens: { id: string; device_name: string | null }[] };
    const row = body.tokens.find((t) => t.device_name === 'test');
    expect(row).toBeDefined();

    const del = await app.request(`/api/notifications/push-tokens/${row!.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(200);
  });
});
