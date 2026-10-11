/**
 * Better-Auth single-use tokens with Valkey as secondary storage — the
 * configuration of every production install. The harness deletes VALKEY_URL,
 * so the rest of the suite runs auth on Postgres alone; that is how a
 * secondary storage without `getAndDelete` broke password reset, magic links
 * and every OTP for 13 betas while all tests stayed green.
 *
 * Runs only when HARNESS_VALKEY_URL names a reachable Valkey (the CI job
 * "Harness auth on Valkey" provides one); skipped otherwise.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _internalForTests as authTesting, getAuth, initAuth } from '../../lib/auth.js';
import { _setCacheForTests, getCache } from '../../lib/runtime/cache.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const VALKEY = process.env.HARNESS_VALKEY_URL;
const d = harnessAvailable() && VALKEY ? describe : describe.skip;

d('auth single-use tokens on Valkey secondary storage', () => {
  let app: Hono;
  let db: Database;
  let appAuth: ReturnType<typeof getAuth>;
  let auth: NonNullable<Awaited<ReturnType<typeof initAuth>>>;
  const saved = { valkey: process.env.VALKEY_URL, smtp: process.env.SMTP_HOST };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    appAuth = getAuth();
    process.env.VALKEY_URL = VALKEY;
    // Mail configured is what turns on the magic-link plugin and reset mails.
    process.env.SMTP_HOST = '127.0.0.1';
    const built = await initAuth(db);
    if (!built) throw new Error('initAuth returned no instance');
    auth = built;
    expect(getCache()).not.toBeNull();
  });

  afterAll(async () => {
    authTesting.setAuthForTests(appAuth);
    await getCache()?.quit();
    _setCacheForTests(null);
    for (const [k, v] of [
      ['VALKEY_URL', saved.valkey],
      ['SMTP_HOST', saved.smtp],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a magic link signs in once and is consumed', async () => {
    const { userId, email } = await createMemberSession(app, db);
    await sql`UPDATE "user" SET "emailVerified" = true WHERE id = ${userId}`.execute(db);
    const ctx = await auth.$context;
    const token = crypto.randomUUID().replaceAll('-', '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    await ctx.internalAdapter.createVerificationValue({
      identifier: Buffer.from(digest).toString('base64url'), // the plugin's `storeToken: 'hashed'`
      value: JSON.stringify({ email }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const url = new URL(`/api/auth/magic-link/verify?token=${token}`, ctx.baseURL);

    const first = await auth.handler(new Request(url));
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie') ?? '').toContain('session_token');
    const again = await auth.handler(new Request(url));
    expect(again.headers.get('set-cookie') ?? '').not.toContain('session_token');
  });

  it('a password-reset token changes the password once and is consumed', async () => {
    const { userId, email } = await createMemberSession(app, db);
    const ctx = await auth.$context;
    const token = crypto.randomUUID().replaceAll('-', '');
    await ctx.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const reset = (newPassword: string) =>
      auth.handler(
        new Request(new URL('/api/auth/reset-password', ctx.baseURL), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, newPassword }),
        }),
      );

    expect((await reset('ResetByValkey123!')).status).toBe(200);
    expect((await reset('SecondUse123456!')).status).toBe(400);
    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'ResetByValkey123!' }),
    });
    expect(signIn.status).toBe(200);
  });
});
