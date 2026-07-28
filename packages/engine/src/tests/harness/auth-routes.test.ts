/**
 * Phase A coverage — routes/auth.ts: the /api/me profile endpoints and the
 * /api/invitations invite-metadata + accept flow. Seeds invitation rows
 * directly (the admin invite-create side lives in users.ts) and drives the
 * public accept path. In-process + DB, no external service.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const VALID_TOKEN = `harness-invite-valid-${STAMP}-aaaaaaaaaaaa`;
const EXPIRED_TOKEN = `harness-invite-expired-${STAMP}-bbbbbbbbbb`;
const USED_TOKEN = `harness-invite-used-${STAMP}-cccccccccccc`;
const ACCEPT_TOKEN = `harness-invite-accept-${STAMP}-dddddddddd`;

d('auth + invitation routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const hour = 3_600_000;
    await db
      .insertInto('zv_invitations')
      .values([
        {
          email: `invitee-${STAMP}@test.invalid`,
          name: 'Invitee',
          role: 'member',
          token: VALID_TOKEN,
          expires_at: new Date(Date.now() + hour),
        },
        {
          email: `expired-${STAMP}@test.invalid`,
          role: 'member',
          token: EXPIRED_TOKEN,
          expires_at: new Date(Date.now() - hour),
        },
        {
          email: `used-${STAMP}@test.invalid`,
          role: 'member',
          token: USED_TOKEN,
          expires_at: new Date(Date.now() + hour),
          accepted_at: new Date(),
        },
        {
          email: `accept-${STAMP}@test.invalid`,
          name: 'Accepted',
          role: 'member',
          token: ACCEPT_TOKEN,
          expires_at: new Date(Date.now() + hour),
        },
      ] as never)
      .execute();
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zv_invitations')
      .where('token', 'in', [VALID_TOKEN, EXPIRED_TOKEN, USED_TOKEN, ACCEPT_TOKEN])
      .execute()
      .catch(() => {});
  });

  it('GET /api/me → 401 anonymous, 200 with a session', async () => {
    expect((await app.request('/api/me')).status).toBe(401);
    const authed = await app.request('/api/me', { headers: { cookie } });
    expect(authed.status).toBe(200);
  });

  it('PATCH /api/me updates the profile (authed), 401 anonymous', async () => {
    const anon = await app.request('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(anon.status).toBe(401);
    const res = await app.request('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `God ${STAMP}` }),
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/invitations/:token → 200 for a valid invite', async () => {
    const res = await app.request(`/api/invitations/${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; role: string };
    expect(body.role).toBe('member');
  });

  it('GET /api/invitations/:token → 404 unknown, 410 used, 410 expired', async () => {
    expect((await app.request(`/api/invitations/nope-${STAMP}-xxxxxxxxxxxxxxxx`)).status).toBe(404);
    expect((await app.request(`/api/invitations/${USED_TOKEN}`)).status).toBe(410);
    expect((await app.request(`/api/invitations/${EXPIRED_TOKEN}`)).status).toBe(410);
  });

  it('POST /api/invitations/accept → 404 for an unknown token', async () => {
    const res = await app.request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: `missing-${STAMP}-xxxxxxxxxxxxxxxx`, password: 'Passw0rd!' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/invitations/accept provisions the user for a valid invite', async () => {
    const res = await app.request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ACCEPT_TOKEN, password: 'Passw0rd!123', name: 'Accepted' }),
    });
    expect([200, 201]).toContain(res.status);
    // The invite is now consumed → a second accept is 410.
    const again = await app.request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ACCEPT_TOKEN, password: 'Passw0rd!123' }),
    });
    expect(again.status).toBe(410);
  });
});
