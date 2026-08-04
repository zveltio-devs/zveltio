/**
 * Changing a password ends every other session.
 *
 * better-auth reads `revokeOtherSessions` from the request body, so this was a
 * decision each caller made for itself, and the Studio's profile page sent
 * neither the flag nor a value — which means false. A user who changes their
 * password *because* they believe someone is in their account kept that someone
 * signed in. The reset flow already disagreed (`revokeSessionsOnPasswordReset:
 * true` in the auth config), so the same intent expressed two ways produced two
 * outcomes.
 *
 * Found by driving a live instance, not by reading: the old cookie still
 * answered 200 on a tenant-scoped read after the password had changed. Nothing
 * in the source says "other sessions survive" — it is what the default means.
 *
 * The test drives real HTTP with real cookies for the same reason. A unit test
 * of the middleware would assert that a flag gets added, which is the thing I
 * already believed before measuring.
 */

import { describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/** Collapse a Set-Cookie header into something usable as a request `cookie`. */
function cookieOf(res: Response): string {
  return (res.headers.get('set-cookie') ?? '')
    .split(',')
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
}

async function signIn(app: Hono, email: string, password: string): Promise<Response> {
  return app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

d('POST /api/auth/change-password', () => {
  it('revokes other sessions even when the caller does not ask', async () => {
    const { app } = await getTestApp();
    const email = `pwrot-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;

    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Test12345', name: 'Rotator' }),
    });
    expect([200, 201]).toContain(signUp.status);
    const first = cookieOf(signUp);

    // A second sign-in for the same user: the session an attacker would be
    // holding, or simply the user's other browser.
    const second = cookieOf(await signIn(app, email, 'Test12345'));
    expect(second).not.toBe('');

    const stillValid = async (cookie: string) => {
      const res = await app.request('/api/auth/get-session', { headers: { cookie } });
      // better-auth answers 200 with a null body for a session that no longer
      // exists, so status alone would pass against the bug.
      return (await res.text()).includes('"user"');
    };
    expect(await stillValid(second)).toBe(true);

    // Exactly what the Studio sends: no `revokeOtherSessions` at all.
    const changed = await app.request('/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: first,
        origin: 'http://localhost',
      },
      body: JSON.stringify({ currentPassword: 'Test12345', newPassword: 'Rotated123456' }),
    });
    expect(changed.status).toBe(200);

    expect(await stillValid(second)).toBe(false);
  }, 30_000);

  it('leaves a body it cannot parse to better-auth', async () => {
    // The guard clones and re-serialises the body. One it cannot read must fall
    // through untouched, or the endpoint starts answering in the middleware's
    // words instead of the auth library's.
    const { app } = await getTestApp();
    const res = await app.request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: 'not-json',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  }, 30_000);
});
