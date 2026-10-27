/**
 * A user session works with no cookie at all: `Authorization: Bearer <token>`
 * (ADR 0006 — a native client signs in, steps up and configures without a
 * cookie jar). The token is the signed value `set-auth-token` hands back.
 *
 * Probe: sign-in → engine route → passkey enrollment → step-up → configuration
 * mutation → sign-out, every request carrying only the bearer; a tampered and
 * an unsigned token refused; a `zvk_` key in the same header still a key; page
 * script holding the cookie never handed the token.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { passkeyRelyingParty } from '../../lib/auth.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { newSoftPasskey, passkeyStepUp, registerSoftPasskey } from '../../testing/step-up.js';

const d = harnessAvailable() ? describe : describe.skip;
const PASSWORD = 'HarnessGod123!';

d('bearer session tokens', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>['app'];
  let cookie = '';
  let email = '';
  let token = '';

  const as =
    (auth: string) =>
    (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: auth },
      });
  const bearer = (path: string, init?: RequestInit) => as(`Bearer ${token}`)(path, init);
  const signIn = (headers: Record<string, string> = {}) =>
    app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ email, password: PASSWORD }),
    });

  beforeAll(async () => {
    const t = await getTestApp();
    app = t.app;
    cookie = await createGodSession(app, t.db, { factor: false });
    const s = await app.request('/api/auth/get-session', { headers: { cookie } });
    email = ((await s.json()) as { user: { email: string } }).user.email;
  });

  it('sign-in without a cookie returns the signed session token', async () => {
    const res = await signIn();
    expect(res.status).toBe(200);
    token = res.headers.get('set-auth-token') ?? '';
    expect(token).toContain('.');
  });

  it('a caller holding the session cookie is never handed the token', async () => {
    const res = await signIn({ cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-auth-token')).toBeNull();
  });

  it('the bearer resolves the session on Better Auth and engine routes', async () => {
    const s = await bearer('/api/auth/get-session');
    expect(((await s.json()) as { user: { email: string } }).user.email).toBe(email);
    expect((await bearer('/api/me')).status).toBe(200);
  });

  it('a tampered or unsigned token is anonymous, as a bad cookie is', async () => {
    const [raw, sig] = token.split('.') as [string, string];
    const flipped = `${raw}.${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
    for (const bad of [`Bearer ${flipped}`, `Bearer ${raw}`]) {
      expect((await as(bad)('/api/me')).status).toBe(401);
      const cfg = await as(bad)('/api/permissions/cache/invalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(cfg.status).toBe(401);
    }
  });

  it('steps up and configures with the bearer alone', async () => {
    const invalidate = () =>
      bearer('/api/permissions/cache/invalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    expect(((await (await invalidate()).json()) as { code: string }).code).toBe(
      'step_up_enrollment_required',
    );

    const { origin } = passkeyRelyingParty();
    const pk = await newSoftPasskey();
    const reg = await registerSoftPasskey(bearer, '', pk, origin, { password: PASSWORD });
    expect(reg.status).toBe(200);
    expect(((await (await invalidate()).json()) as { code: string }).code).toBe('step_up_required');

    await passkeyStepUp(bearer, '', pk, 'config', origin);
    expect((await invalidate()).status).toBe(200);

    // A key minted by the bearer session is still a key in the same header.
    const k = await bearer('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `bearer ${Date.now()}`, scopes: [] }),
    });
    expect(k.status).toBe(200);
    const { key } = (await k.json()) as { key: string };
    expect((await as(`Bearer ${key}`)('/api/api-keys/self')).status).toBe(200);
  });

  it('sign-out with the bearer ends that session', async () => {
    const out = await bearer('/api/auth/sign-out', { method: 'POST' });
    expect(out.status).toBe(200);
    expect((await bearer('/api/me')).status).toBe(401);
  });
});
