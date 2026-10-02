/**
 * POST /api/notifications/broadcast — what `action_url` it takes.
 *
 * The schema was `z.string().url().refine(http(s) or "/…")`: `.url()` runs first
 * and refuses every relative path, so the in-app path its own message allowed
 * answered 400, while `//evil.example` would have passed the refine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TITLE = `action-url-${Date.now()}`;

d('broadcast action_url', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    ({ userId: member } = await createMemberSession(app, db));
  });

  afterAll(async () => {
    if (db) await sql`DELETE FROM zv_notifications WHERE title = ${TITLE}`.execute(db);
  });

  const send = (action_url: string) =>
    app.request('/api/notifications/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ user_id: member, title: TITLE, message: 'm', action_url }),
    });

  it('accepts an in-app path and an https link', async () => {
    expect((await send('/intranet/notifications')).status).toBeLessThan(300);
    expect((await send('https://zveltio.com/x')).status).toBeLessThan(300);
  });

  it('refuses javascript:, data: and a protocol-relative off-site link', async () => {
    for (const u of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x']) {
      expect((await send(u)).status).toBe(400);
    }
  });
});
