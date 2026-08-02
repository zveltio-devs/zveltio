/**
 * Self-registration is refused at user creation, not at a URL pattern.
 *
 * The gate was HTTP middleware on `POST /api/auth/sign-up/*`, which covers
 * exactly one of the ways an account can be acquired. Magic link found the gap
 * first — it signs people in, so it is not a sign-up route, and it created
 * users until `disableSignUp: true` was added. OAuth had the same shape and no
 * such flag, so on any instance with a social provider configured and
 * `registration_enabled` at its default of OFF, an unknown Google account
 * became a Zveltio account.
 *
 * The check now sits on the one thing every flow must do — insert a row into
 * `user` — so this asserts the invariant rather than the route list: with
 * registration off, nothing creates a user except the paths that say they are
 * authorized to.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withAuthorizedUserCreation } from '../../lib/auth.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const STAMP = Date.now();
const STRANGER = `stranger-${STAMP}@example.test`;
const INVITED = `invited-${STAMP}@example.test`;
const TOKEN = `chokepoint${'0'.repeat(24)}${STAMP}`.slice(0, 48);
const PASSWORD = 'correct horse battery staple';

d('registration gate is enforced at user creation', () => {
  let app: Hono;
  let db: Database;
  let previous: string | undefined;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    // The harness turns self-registration on so it can create its own god
    // user. Turn it off for these cases — that default is the whole point.
    previous = process.env.ZVELTIO_REGISTRATION_ENABLED;
    process.env.ZVELTIO_REGISTRATION_ENABLED = '0';

    await sql`
      INSERT INTO zv_invitations (email, name, role, token, expires_at)
      VALUES (${INVITED}, 'Invited', 'member', ${TOKEN}, NOW() + INTERVAL '7 days')
    `.execute(db);
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.ZVELTIO_REGISTRATION_ENABLED;
    else process.env.ZVELTIO_REGISTRATION_ENABLED = previous;
    if (!db) return;
    await sql`DELETE FROM zv_invitations WHERE token = ${TOKEN}`.execute(db).catch(() => {});
    for (const email of [STRANGER, INVITED]) {
      const u = await db
        .selectFrom('user')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst()
        .catch(() => null);
      if (!u) continue;
      await sql`DELETE FROM "account" WHERE "userId" = ${u.id}`.execute(db).catch(() => {});
      await sql`DELETE FROM "session" WHERE "userId" = ${u.id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_tenant_users WHERE user_id = ${u.id}`.execute(db).catch(() => {});
      await sql`DELETE FROM "user" WHERE id = ${u.id}`.execute(db).catch(() => {});
    }
  });

  it('refuses to create a user when self-registration is off', async () => {
    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: STRANGER, password: PASSWORD, name: 'Stranger' }),
    });
    expect(res.status).toBe(403);

    const created = await db
      .selectFrom('user')
      .select('id')
      .where('email', '=', STRANGER)
      .executeTakeFirst();
    expect(created).toBeUndefined();
  });

  it('refuses creation even when the route middleware is bypassed', async () => {
    // This is the case the route gate could never see: a plugin that creates a
    // user from a path that is not `/sign-up/*`. Calling the API directly is
    // the same entry point such a plugin uses.
    const { getAuth } = await import('../../lib/auth.js');
    let threw = false;
    try {
      await getAuth().api.signUpEmail({
        body: { email: STRANGER, password: PASSWORD, name: 'Stranger' },
        headers: new Headers({ 'Content-Type': 'application/json' }),
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const created = await db
      .selectFrom('user')
      .select('id')
      .where('email', '=', STRANGER)
      .executeTakeFirst();
    expect(created).toBeUndefined();
  });

  it('still lets an admin invitation create its user', async () => {
    // The gate must not break the one flow that is supposed to add people
    // while self-registration is off.
    const res = await app.request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, password: PASSWORD, name: 'Invited' }),
    });
    expect(res.status).toBe(201);

    const created = await db
      .selectFrom('user')
      .select('id')
      .where('email', '=', INVITED)
      .executeTakeFirst();
    expect(created).toBeDefined();
  });

  it('scopes the authorization to the call, not the process', async () => {
    // A leaked flag would silently re-open registration for everything that
    // followed, which is worse than the hole it closed.
    await withAuthorizedUserCreation(async () => 'done');
    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: STRANGER, password: PASSWORD, name: 'Stranger' }),
    });
    expect(res.status).toBe(403);
  });
});
