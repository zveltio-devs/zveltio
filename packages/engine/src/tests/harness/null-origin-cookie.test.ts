/**
 * ADR 0038 decision 11: a request whose `Origin` is `null` never authenticates by
 * cookie. A sandboxed frame (an extension's document, or any page's) sends that
 * origin, and with `CROSS_DOMAIN_AUTH=true` the session cookie is `SameSite=None`,
 * so the browser attaches it. The same cookie with a real Origin still works.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('Origin: null never authenticates by cookie', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>['app'];
  let cookie = '';

  beforeAll(async () => {
    const t = await getTestApp();
    app = t.app;
    cookie = await createGodSession(app, t.db, { factor: false });
  });

  it('the cookie alone signs the caller in', async () => {
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(200);
  });

  it('the same cookie from an opaque origin is anonymous, on engine and Better Auth routes', async () => {
    const headers = { cookie, origin: 'null' };
    expect((await app.request('/api/me', { headers })).status).toBe(401);
    const s = await app.request('/api/auth/get-session', { headers });
    expect(await s.json()).toBeNull();
    // Better Auth answers a cookieless sign-out with success; the session must survive it.
    await app.request('/api/auth/sign-out', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(200);
  });
});
