/**
 * `?channel=` is gated like `?collection=`.
 *
 * The collection parameter went through Casbin; the channel parameter was
 * forwarded to Redis untouched. Because a bare channel is prefixed with
 * `zveltio:`, `?channel=data:zvd_salaries` produced exactly the subscription the
 * collection gate exists to prevent — the same channel, one query parameter to
 * the left.
 *
 * The wildcard rule (`?collection=` absent ⇒ admin only) meant the attack needed
 * a readable collection to get past it, then the channel for one it could not
 * read. That combination is what these tests drive.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();

/** A plain member — the role the gate exists to constrain. */
async function createMemberSession(app: Hono): Promise<string | null> {
  const email = `member-${STAMP}@test.local`;
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Harness-Member-1234', name: 'Harness Member' }),
  });
  if (!res.ok && res.status !== 200 && res.status !== 201) return null;
  return res.headers.get('set-cookie')?.split(';')[0] ?? null;
}

d('realtime ?channel= permission gate', () => {
  let app: Hono;
  let db: Database;
  let godCookie: string;
  let memberCookie: string | null = null;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    memberCookie = await createMemberSession(app);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM "user" WHERE email = ${`member-${STAMP}@test.local`}`
      .execute(db)
      .catch(() => {});
  });

  it('refuses an anonymous stream', async () => {
    const res = await app.request('/api/realtime/stream?channel=data:zvd_accounts');
    expect(res.status).toBe(401);
  });

  it('a member cannot reach a collection channel it has no read on', async () => {
    if (!memberCookie) return; // signup disabled in this environment
    const res = await app.request(
      '/api/realtime/stream?collection=zvd_accounts&channel=data:zvd_secret_payroll',
      { headers: { cookie: memberCookie } },
    );
    // Either the collection gate refuses outright (no read on anything), or the
    // stream opens without the channel it was not entitled to. What must NOT
    // happen is the channel being subscribed.
    if (res.status === 200) {
      const body = await res.text();
      expect(body).not.toContain('zveltio:data:zvd_secret_payroll');
    } else {
      expect([403, 401]).toContain(res.status);
    }
  });

  it('a member cannot reach an internal channel by name', async () => {
    if (!memberCookie) return;
    const res = await app.request(
      '/api/realtime/stream?collection=zvd_accounts&channel=notifications',
      { headers: { cookie: memberCookie } },
    );
    if (res.status === 200) {
      const body = await res.text();
      expect(body).not.toContain('zveltio:notifications');
    } else {
      expect([403, 401]).toContain(res.status);
    }
  });

  it('an admin still gets the channels it asks for', async () => {
    // The gate must not simply refuse everything — that would "pass" while
    // breaking the feature.
    const res = await app.request('/api/realtime/stream?channel=system', {
      headers: { cookie: godCookie },
    });
    expect(res.status).toBe(200);
  });
});
