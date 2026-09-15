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

// Real-shaped Push API values: the route checks sizes, because a malformed
// subscription that is accepted here simply never receives anything later.
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const P256DH_2 =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const AUTH_SECRET = 'BTBZMqHH6r4Tts7J_aSIgg';
const AUTH_SECRET_2 = 'Zm9vYmFyYmF6cXV4MTIzNA';

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

  it('a device token has one owner at a time', async () => {
    // The table was UNIQUE (user_id, token), which leaves the token itself
    // free: the token arrives in the request body, so a second account could
    // register a device the first had registered and have its own
    // notifications delivered there — sendPushToUser selects by user_id, so
    // BOTH rows were live. Migration 013 makes the token unique; registering it
    // again moves it rather than duplicating it.
    const token = `tok-owner-${Date.now()}`;
    const other = `other-${Date.now()}`;
    await sql`
      INSERT INTO "user" (id, name, email) VALUES (${other}, 'Other', ${`${other}@example.com`})
    `.execute(db);
    await sql`
      INSERT INTO zvd_push_tokens (user_id, token, platform) VALUES (${other}, ${token}, 'fcm')
    `.execute(db);

    try {
      const reg = await app.request(
        '/api/notifications/push-tokens',
        json('POST', { token, platform: 'fcm', device_name: 'claimed' }),
      );
      expect(reg.status).toBe(200);

      const rows = await sql<{ user_id: string }>`
        SELECT user_id FROM zvd_push_tokens WHERE token = ${token}
      `.execute(db);
      expect(rows.rows).toHaveLength(1); // moved, not duplicated
      expect(rows.rows[0]?.user_id).toBe(userId);
    } finally {
      await sql`DELETE FROM zvd_push_tokens WHERE token = ${token}`.execute(db).catch(() => {});
      await sql`DELETE FROM "user" WHERE id = ${other}`.execute(db).catch(() => {});
    }
  });

  it('does not let a caller take over another user’s web push subscription', async () => {
    // `endpoint` is unique table-wide and the upsert used to reassign `user_id`,
    // so posting an endpoint that belongs to somebody else moved their
    // subscription to the caller: the victim stops receiving their own web push
    // and the caller's notifications are delivered to the victim's browser.
    const endpoint = `https://push.example.com/ep-${Date.now()}`;
    const victim = `victim-${Date.now()}`;
    await sql`
      INSERT INTO "user" (id, name, email) VALUES (${victim}, 'Victim', ${`${victim}@example.com`})
    `.execute(db);
    await sql`
      INSERT INTO zv_push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${victim}, ${endpoint}, ${P256DH}, ${AUTH_SECRET})
    `.execute(db);

    try {
      const res = await app.request(
        '/api/notifications/push/subscribe',
        json('POST', { endpoint, p256dh: P256DH_2, auth: AUTH_SECRET_2 }),
      );
      expect(res.status).toBe(409);

      const after = await sql<{ user_id: string; p256dh: string }>`
        SELECT user_id, p256dh FROM zv_push_subscriptions WHERE endpoint = ${endpoint}
      `.execute(db);
      expect(after.rows[0]?.user_id).toBe(victim);
      expect(after.rows[0]?.p256dh).toBe(P256DH);
    } finally {
      await sql`DELETE FROM zv_push_subscriptions WHERE endpoint = ${endpoint}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM "user" WHERE id = ${victim}`.execute(db).catch(() => {});
    }
  });

  it('still refreshes the caller’s own web push subscription', async () => {
    const endpoint = `https://push.example.com/own-${Date.now()}`;
    try {
      const first = await app.request(
        '/api/notifications/push/subscribe',
        json('POST', { endpoint, p256dh: P256DH, auth: AUTH_SECRET }),
      );
      expect(first.status).toBe(201);

      const second = await app.request(
        '/api/notifications/push/subscribe',
        json('POST', { endpoint, p256dh: P256DH_2, auth: AUTH_SECRET_2 }),
      );
      expect(second.status).toBe(201);

      const after = await sql<{ user_id: string; p256dh: string }>`
        SELECT user_id, p256dh FROM zv_push_subscriptions WHERE endpoint = ${endpoint}
      `.execute(db);
      expect(after.rows[0]?.user_id).toBe(userId);
      expect(after.rows[0]?.p256dh).toBe(P256DH_2);
    } finally {
      await sql`DELETE FROM zv_push_subscriptions WHERE endpoint = ${endpoint}`
        .execute(db)
        .catch(() => {});
    }
  });
});
