/**
 * Notifications — Integration Tests
 *
 * Tests in-app notifications: list, mark as read/unread, delete, mark-all-read,
 * admin broadcast, and auth enforcement.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/notifications.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

let db: Database;
let godCookie: string;
let regularCookie: string;
let regularUserId: string;
let notificationId: string;

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);

  // God user
  const godEmail = `god-notif-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!', name: 'Notif God' }),
  });
  // One god per instance since migration 008 — the previous holder is
  // stood down first, the same move the in-process harness makes.
  await sql`UPDATE "user" SET role = 'member' WHERE role = 'god'`.execute(db);
  await sql`UPDATE "user" SET role = 'god' WHERE email = ${godEmail}`.execute(db);
  const godRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!' }),
  });
  godCookie = godRes.headers.get('set-cookie') ?? '';

  // Regular user
  const regEmail = `reg-notif-${Date.now()}@test.local`;
  const regSignup = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regEmail, password: 'RegPass123!', name: 'Notif Regular' }),
  });
  const regBody = (await regSignup.json()) as any;
  regularUserId = regBody.user?.id ?? regBody.id;

  const regRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regEmail, password: 'RegPass123!' }),
  });
  regularCookie = regRes.headers.get('set-cookie') ?? '';
});

afterAll(async () => {
  if (skipAll || !db) return;
  await db.destroy().catch(() => {});
});

const TITLE = `Integration Test ${Date.now()}`;

async function readAs(cookie: string, id: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/notifications/${id}`, { headers: { Cookie: cookie } });
}

async function isRead(id: string): Promise<boolean> {
  const res = await readAs(regularCookie, id);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).notification.is_read;
}

describe.skipIf(skipAll)('Notifications — Integration', () => {
  it('GET /api/notifications — returns 401 unauthenticated', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications`);
    expect(res.status).toBe(401);
  });

  it('POST /api/notifications/broadcast — sends notification (god)', async () => {
    expect(regularUserId).toBeTruthy();
    const res = await fetch(`${BASE_URL}/api/notifications/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: godCookie },
      body: JSON.stringify({
        user_id: regularUserId,
        title: TITLE,
        message: 'This is a test notification',
        type: 'info',
      }),
    });
    expect(res.status).toBeOneOf([200, 201]);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.sent_to).toBe(1);
  });

  it('POST /api/notifications/broadcast — returns 403 for non-admin', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: regularCookie },
      body: JSON.stringify({
        title: 'Hack',
        message: 'Should not work',
        type: 'info',
      }),
    });
    expect(res.status).toBeOneOf([401, 403]);
  });

  it('GET /api/notifications — the broadcast reached the recipient, unread', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications`, {
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.stats).toHaveProperty('total');
    expect(body.stats).toHaveProperty('unread');
    const mine = body.notifications.find((n: any) => n.title === TITLE);
    expect(mine).toBeTruthy();
    expect(mine.is_read).toBe(false);
    notificationId = mine.id;
  });

  it('GET /api/notifications?unread_only=true — filters unread', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications?unread_only=true`, {
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.notifications.some((n: any) => n.id === notificationId)).toBe(true);
    expect(body.notifications.every((n: any) => n.is_read === false)).toBe(true);
  });

  // Every mutation below is scoped by `user_id = caller`. Drop that predicate
  // and another account could read, flip or delete someone else's inbox —
  // nothing else in the suite would notice, because every other call is the
  // owner acting on their own row.
  it("another user cannot read, mark or delete the recipient's notification", async () => {
    expect((await readAs(godCookie, notificationId)).status).toBe(404);
    await fetch(`${BASE_URL}/api/notifications/${notificationId}/read`, {
      method: 'PATCH',
      headers: { Cookie: godCookie },
    });
    expect(await isRead(notificationId)).toBe(false);
    await fetch(`${BASE_URL}/api/notifications/mark-all-read`, {
      method: 'POST',
      headers: { Cookie: godCookie },
    });
    expect(await isRead(notificationId)).toBe(false);
    await fetch(`${BASE_URL}/api/notifications/${notificationId}`, {
      method: 'DELETE',
      headers: { Cookie: godCookie },
    });
    expect((await readAs(regularCookie, notificationId)).status).toBe(200);
  });

  it('PATCH /api/notifications/:id/read — marks notification as read', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications/${notificationId}/read`, {
      method: 'PATCH',
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBeOneOf([200, 204]);
    expect(await isRead(notificationId)).toBe(true);
  });

  it('PATCH /api/notifications/:id/unread — marks notification as unread', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications/${notificationId}/unread`, {
      method: 'PATCH',
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBeOneOf([200, 204]);
    expect(await isRead(notificationId)).toBe(false);
  });

  it('POST /api/notifications/mark-all-read — marks all as read', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications/mark-all-read`, {
      method: 'POST',
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBeOneOf([200, 204]);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(await isRead(notificationId)).toBe(true);
  });

  it('DELETE /api/notifications/:id — deletes notification', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications/${notificationId}`, {
      method: 'DELETE',
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBeOneOf([200, 204]);
    expect((await readAs(regularCookie, notificationId)).status).toBe(404);
  });

  it('DELETE /api/notifications/clear-all — clears all read notifications', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications/clear-all`, {
      method: 'DELETE',
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBeOneOf([200, 204]);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
  });
});
