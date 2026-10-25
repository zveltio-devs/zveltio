/**
 * God step-up for extension mutations (lib/step-up.ts, RFC extension model v3,
 * "Installing and trusting code" item 3).
 *
 * Before: a god session alone installed, enabled, configured or removed an
 * extension — a stolen cookie was enough to put code on the instance. Now each
 * mutation spends a single-use token minted by a passkey assertion (TOTP only
 * when the account has no passkey), bound to the session and the action.
 *
 * Driven as the Studio drives it: a software ES256 authenticator through Better
 * Auth's real registration endpoints, real assertions through the real verifier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { github } from 'better-auth/social-providers';
import { getAuth, passkeyRelyingParty } from '../../lib/auth.js';
import { firstFactorRule, noteSessionOrigin } from '../../lib/step-up.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
  recoverGod,
} from '../../testing/app-harness.js';
import {
  enrollTotp,
  newSoftPasskey,
  passkeyStepUp,
  registerSoftPasskey,
  softAssertion,
  type SoftPasskey,
  totpCode,
} from '../../testing/step-up.js';

const d = harnessAvailable() ? describe : describe.skip;
const PASSWORD = 'HarnessGod123!';
const PROBE = `stepup-probe-${Date.now()}`;

d('god step-up for extension mutations', () => {
  let app: Hono;
  let db: Database;
  let origin: string;
  let cookie: string;
  let email: string;
  let pk: SoftPasskey;
  const req = (path: string, init?: RequestInit) => app.request(path, init);
  const config = (name: string, headers: Record<string, string> = {}, as = cookie) =>
    app.request(`/api/marketplace/${name}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: as, ...headers },
      body: JSON.stringify({ probe: true }),
    });
  const token = (action: string, as = cookie) => passkeyStepUp(req, as, pk, action, origin);
  const header = (t: string) => ({ 'X-Zveltio-Step-Up': t });
  const signIn = async () => {
    const res = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    origin = passkeyRelyingParty().origin;
    cookie = await createGodSession(app, db);
    const me = await app.request('/api/me', { headers: { cookie } });
    email = ((await me.json()) as { user: { email: string } }).user.email;
    pk = await newSoftPasskey();
    // Installed: config on a name never installed is 404, before or after the gate.
    for (const name of [PROBE, `${PROBE}-a`]) {
      await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed)
                VALUES (${name}, ${name}, true)`.execute(db);
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_extension_registry WHERE name LIKE 'stepup-probe%'`.execute(db);
  });

  it('a god with no factor is told to enroll one', async () => {
    const res = await config(PROBE);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('step_up_enrollment_required');
  });

  it('the password for a first passkey can be checked before the ceremony, and only then', async () => {
    // A wrong one refused only at verify-registration leaves the authenticator
    // holding a discoverable credential the server never stored.
    const check = (password?: string, as = cookie) =>
      app.request('/api/auth/step-up/check-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: as },
        body: JSON.stringify({ password }),
      });
    const wrong = await check('nope-nope-1');
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { code: string }).code).toBe('password_required');
    expect((await check()).status).toBe(403);
    expect((await check(PASSWORD)).status).toBe(204);
    expect((await check(PASSWORD, '')).status).toBe(401);
    // A probe changes nothing: the password is still asked at registration.
    const none = await registerSoftPasskey(req, cookie, pk, origin);
    expect(((await none.json()) as { code: string }).code).toBe('password_required');
  });

  it('the first passkey needs the password', async () => {
    const none = await registerSoftPasskey(req, cookie, pk, origin);
    expect(none.status).toBe(403);
    expect(((await none.json()) as { code: string }).code).toBe('password_required');
    const wrong = await registerSoftPasskey(req, cookie, pk, origin, { password: 'nope-nope-1' });
    expect(wrong.status).toBe(403);
    const ok = await registerSoftPasskey(req, cookie, pk, origin, { password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('a step-up passkey must verify its user (PIN or biometrics); presence alone is refused', async () => {
    const action = `extension.config:${PROBE}`;
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
    const options = async () => {
      const o = await post('/api/auth/step-up/options', { action });
      return (
        (await o.json()) as {
          options: { challenge: string; rpId: string; userVerification: string };
        }
      ).options;
    };
    const o1 = await options();
    expect(o1.userVerification).toBe('required');
    const bare = await softAssertion(pk, o1.challenge, o1.rpId, origin, { uv: false });
    const refused = await post('/api/auth/step-up/verify', { action, response: bare });
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { code: string; detail: string };
    expect(body.code).toBe('step_up_user_verification_required');
    expect(body.detail).toMatch(/PIN/);
    // No authenticator app on this account, so the message does not offer one.
    expect(body.detail).not.toMatch(/authenticator app/);
    const o2 = await options();
    const verified = await softAssertion(pk, o2.challenge, o2.rpId, origin);
    expect((await post('/api/auth/step-up/verify', { action, response: verified })).status).toBe(
      200,
    );
  });

  it('a mutation without a token is refused; reads are not', async () => {
    const res = await config(PROBE);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('step_up_required');
    expect((await app.request('/api/marketplace', { headers: { cookie } })).status).toBe(200);
  });

  it('a valid token lets exactly one mutation through, and the audit row names the method', async () => {
    const t = await token(`extension.config:${PROBE}`);
    expect((await config(PROBE, header(t))).status).toBe(200);
    expect((await config(PROBE, header(t))).status).toBe(403);
    // The god row is written after the request settles, behind the response.
    const rows = async () =>
      (
        await sql<{ metadata: { step_up?: string; status: number } }>`
          SELECT metadata FROM zv_audit_log
           WHERE event_type = 'god_action' AND resource_id = ${`/api/marketplace/${PROBE}/config`}
             AND (metadata->>'status')::int = 200`.execute(db)
      ).rows;
    for (let i = 0; i < 50 && (await rows()).length === 0; i++) await Bun.sleep(100);
    expect((await rows()).map((r) => r.metadata.step_up)).toEqual(['passkey']);
  });

  it('one token raced by two requests lets exactly one through', async () => {
    const t = await token(`extension.config:${PROBE}`);
    const both = await Promise.all([config(PROBE, header(t)), config(PROBE, header(t))]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 403]);
  });

  it('a token for another action is refused and is not spent by the attempt', async () => {
    const t = await token(`extension.config:${PROBE}-a`);
    expect((await config(`${PROBE}-b`, header(t))).status).toBe(403);
    expect((await config(`${PROBE}-a`, header(t))).status).toBe(200);
  });

  it("a token from another of the god's sessions is refused", async () => {
    const other = await signIn();
    const t = await token(`extension.config:${PROBE}`);
    expect((await config(PROBE, header(t), other)).status).toBe(403);
  });

  it('an expired token is refused', async () => {
    const t = await token(`extension.config:${PROBE}`);
    await sql`UPDATE verification SET "expiresAt" = now() - interval '1 second'
               WHERE identifier = 'step-up:token'`.execute(db);
    expect((await config(PROBE, header(t))).status).toBe(403);
  });

  it('a challenge issued for one action cannot mint a token for another', async () => {
    const o = await app.request('/api/auth/step-up/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'extension.config:a' }),
    });
    const { options } = (await o.json()) as { options: { challenge: string; rpId: string } };
    const response = await softAssertion(pk, options.challenge, options.rpId, origin);
    const v = await app.request('/api/auth/step-up/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'extension.install:a', response }),
    });
    expect(v.status).toBe(403);
  });

  it('a signature by an unregistered key is refused', async () => {
    const o = await app.request('/api/auth/step-up/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'extension.config:a' }),
    });
    const { options } = (await o.json()) as { options: { challenge: string; rpId: string } };
    const forged = await newSoftPasskey();
    forged.credentialId = pk.credentialId; // claims the registered credential
    const response = await softAssertion(forged, options.challenge, options.rpId, origin);
    const v = await app.request('/api/auth/step-up/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'extension.config:a', response }),
    });
    expect(v.status).toBe(403);
  });

  it('a second passkey needs a step-up, not the password', async () => {
    const second = await newSoftPasskey();
    const pw = await registerSoftPasskey(req, cookie, second, origin, { password: PASSWORD });
    expect(pw.status).toBe(403);
    expect(((await pw.json()) as { code: string }).code).toBe('step_up_required');
    // Nor does the pre-ceremony check answer, right password or not, once a factor exists.
    for (const password of [PASSWORD, 'nope-nope-1']) {
      const check = await app.request('/api/auth/step-up/check-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ password }),
      });
      expect(check.status).toBe(409);
    }
    const t = await token('factor.passkey.add');
    const ok = await registerSoftPasskey(req, cookie, second, origin, { headers: header(t) });
    expect(ok.status).toBe(200);
  });

  it('removing a passkey needs a step-up, and the change is audited', async () => {
    const list = await app.request('/api/auth/passkey/list-user-passkeys', { headers: { cookie } });
    const [first] = (await list.json()) as { id: string }[];
    const del = (headers: Record<string, string> = {}) =>
      app.request('/api/auth/passkey/delete-passkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie, ...headers },
        body: JSON.stringify({ id: first!.id }),
      });
    expect((await del()).status).toBe(403);
    expect((await del(header(await token('factor.passkey.remove')))).status).toBe(200);
    await _settleAuditWrites();
    const rows = await sql<{ metadata: { change: string; confirmed_by: string } }>`
      SELECT metadata FROM zv_audit_log
       WHERE event_type = 'auth.factor_changed' AND user_id = (SELECT id FROM "user" WHERE email = ${email})
       ORDER BY created_at`.execute(db);
    expect(rows.rows.map((r) => `${r.metadata.change}/${r.metadata.confirmed_by}`)).toEqual([
      'passkey.add/password',
      'passkey.add/passkey',
      'passkey.remove/passkey',
    ]);
  });

  it('adding TOTP beside a passkey needs a step-up too', async () => {
    const res = await app.request('/api/auth/two-factor/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('step_up_required');
  });

  it('recovery can clear a god whose factors are lost', async () => {
    const res = await recoverGod(app, email, { clear_factors: true });
    expect(res.status).toBe(200);
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM passkey
       WHERE "userId" = (SELECT id FROM "user" WHERE email = ${email})`.execute(db);
    expect(left.rows[0]?.n).toBe(0);
    // The recovery ended every session of the account; the god signs in again.
    expect((await config(PROBE)).status).toBe(401);
    const after = await config(PROBE, {}, await signIn());
    expect(((await after.json()) as { code: string }).code).toBe('step_up_enrollment_required');
  });
});

d('god step-up by TOTP (no passkey on the account)', () => {
  let app: Hono;
  let cookie: string;
  let totpURI: string;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const t = await getTestApp();
    app = t.app;
    ({ cookie, totpURI } = await enrollTotp(
      (p, i) => app.request(p, i),
      await createGodSession(app, t.db),
      PASSWORD,
    ));
  });

  it('a code mints one token; the same code cannot mint another', async () => {
    const action = 'extension.license-rotate';
    const o = await post('/api/auth/step-up/options', { action });
    expect(((await o.json()) as { method: string }).method).toBe('totp');
    const code = totpCode(totpURI);
    const v = await post('/api/auth/step-up/verify', { action, code });
    expect(v.status).toBe(200);
    const { token } = (await v.json()) as { token: string };
    expect(
      (await post('/api/admin/license/rotate', {}, { 'X-Zveltio-Step-Up': token })).status,
    ).toBe(200);
    expect((await post('/api/auth/step-up/verify', { action, code })).status).toBe(403);
  });

  it('a wrong code mints nothing', async () => {
    const action = 'extension.license-rotate';
    const bad = totpCode(totpURI, 5);
    expect((await post('/api/auth/step-up/verify', { action, code: bad })).status).toBe(403);
  });

  it('disabling TOTP needs a step-up on top of the password', async () => {
    expect((await post('/api/auth/two-factor/disable', { password: PASSWORD })).status).toBe(403);
  });

  // Last in this block: it locks the account's TOTP step-up.
  it('wrong codes are counted per account, and no other endpoint checks a code for free', async () => {
    // Better Auth's verify-totp with a session only answered right or wrong.
    const oracle = await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) });
    expect(oracle.status).toBe(400);
    const action = 'extension.license-rotate';
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const bad = totpCode(totpURI, 7 + i);
      statuses.push((await post('/api/auth/step-up/verify', { action, code: bad })).status);
    }
    // Five wrong codes per window, the earlier test's one included; then locked.
    expect(statuses.filter((s) => s === 403).length).toBeLessThanOrEqual(5);
    expect(statuses.at(-1)).toBe(429);
    const right = await post('/api/auth/step-up/verify', { action, code: totpCode(totpURI) });
    expect(right.status).toBe(429);
  });
});

/**
 * An account with no password (OAuth only) has nothing to re-enter for its first
 * factor. It may enroll one from a session that an OAuth sign-in created at most
 * five minutes ago; an account with a password still gives the password.
 *
 * Better Auth's real `/sign-in/social` and `/callback/:id`, with a stand-in
 * identity provider: the token exchange and profile are the only parts faked.
 */
d('first factor on an account with no password', () => {
  let app: Hono;
  let db: Database;
  let origin: string;
  const req = (path: string, init?: RequestInit) => app.request(path, init);
  const idp = { email: '' };
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  type Providers = { socialProviders: { id: string }[] };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    origin = passkeyRelyingParty().origin;
    // Better Auth's GitHub provider with the network half replaced.
    const fake = Object.assign(github({ clientId: 'harness', clientSecret: 'harness' }), {
      validateAuthorizationCode: async () => ({ accessToken: 'harness', tokenType: 'bearer' }),
      getUserInfo: async () => ({
        user: { id: idp.email, email: idp.email, name: 'OAuth Harness', emailVerified: true },
        data: { id: idp.email },
      }),
    });
    const ctx = (await getAuth().$context) as unknown as Providers;
    ctx.socialProviders = [...ctx.socialProviders.filter((p) => p.id !== 'github'), fake];
  });

  afterAll(async () => {
    const ctx = (await getAuth().$context) as unknown as Providers;
    ctx.socialProviders = ctx.socialProviders.filter((p) => p.id !== 'github');
  });

  const oauthSignIn = async (email: string) => {
    idp.email = email;
    const start = await app.request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', callbackURL: '/admin', disableRedirect: true }),
    });
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get('state') ?? '';
    const cb = await app.request(
      `/api/auth/callback/github?code=harness&state=${encodeURIComponent(state)}`,
      { headers: { cookie: cookieOf(start) } },
    );
    expect(cb.status).toBe(302);
    const cookie = cookieOf(cb);
    expect(cookie).toContain('session_token');
    return cookie;
  };
  const newEmail = () => `oauth-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const enableTotp = (cookie: string, body: unknown = {}) =>
    app.request('/api/auth/two-factor/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const firstFactor = async (cookie: string) => {
    const r = await app.request('/api/auth/step-up/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'factor.passkey.add' }),
    });
    const b = (await r.json()) as { code: string; errors?: { first_factor?: string } };
    expect(b.code).toBe('step_up_enrollment_required');
    return b.errors?.first_factor;
  };
  const ageOAuthSignIns = () =>
    sql`UPDATE verification SET "expiresAt" = now() - interval '1 second'
         WHERE identifier = 'step-up:oauth-sign-in'`.execute(db);

  it('a fresh OAuth sign-in enrolls a first passkey without a password, and says so in the audit', async () => {
    const email = newEmail();
    const cookie = await oauthSignIn(email);
    // What the Studio asks before the ceremony: no password prompt for this account.
    expect(await firstFactor(cookie)).toBe('recent_sign_in');
    const check = await app.request('/api/auth/step-up/check-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ password: 'anything-1' }),
    });
    expect(check.status).toBe(409);
    const res = await registerSoftPasskey(req, cookie, await newSoftPasskey(), origin);
    expect(res.status).toBe(200);
    await _settleAuditWrites();
    const rows = await sql<{ metadata: { change: string; confirmed_by: string } }>`
      SELECT metadata FROM zv_audit_log
       WHERE event_type = 'auth.factor_changed'
         AND user_id = (SELECT id FROM "user" WHERE email = ${email})`.execute(db);
    expect(rows.rows.map((r) => `${r.metadata.change}/${r.metadata.confirmed_by}`)).toEqual([
      'passkey.add/oauth',
    ]);
  });

  it('a fresh OAuth sign-in enables TOTP without a password; its secret then needs a step-up', async () => {
    const cookie = await oauthSignIn(newEmail());
    const res = await enableTotp(cookie);
    expect(res.status).toBe(200);
    const { totpURI } = (await res.json()) as { totpURI: string };
    expect(totpURI).toStartWith('otpauth://');
    const v = await app.request('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ code: totpCode(totpURI) }),
    });
    expect(v.status).toBe(200);
    // Without a password Better Auth asks for nothing here: the secret is the factor.
    const confirmed = cookieOf(v) || cookie;
    for (const path of [
      '/api/auth/two-factor/get-totp-uri',
      '/api/auth/two-factor/generate-backup-codes',
    ]) {
      const r = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: confirmed },
        body: '{}',
      });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe('step_up_required');
    }
  });

  it('an OAuth sign-in older than five minutes enrolls nothing', async () => {
    const cookie = await oauthSignIn(newEmail());
    await ageOAuthSignIns();
    expect(await firstFactor(cookie)).toBe('sign_in_again');
    const pk = await registerSoftPasskey(req, cookie, await newSoftPasskey(), origin);
    expect(pk.status).toBe(403);
    expect(((await pk.json()) as { code: string }).code).toBe('recent_sign_in_required');
    const totp = await enableTotp(cookie);
    expect(totp.status).toBe(403);
    expect(((await totp.json()) as { code: string }).code).toBe('recent_sign_in_required');
  });

  // noteSessionOrigin: only a session the OAuth endpoints create is noted, and the
  // note is that session's alone — a later password sign-in is no fresh OAuth sign-in.
  it('only the session an OAuth sign-in created skips the first-factor check', async () => {
    const email = newEmail();
    const up = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Origin Harness' }),
    });
    expect(up.ok).toBe(true);
    await sql`UPDATE "user" SET "emailVerified" = true WHERE email = ${email}`.execute(db);
    const viaOAuth = await oauthSignIn(email);
    const viaPassword = cookieOf(
      await app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    expect(viaPassword).toContain('session_token');
    // The account now has no password: what is left is how each session began.
    await sql`UPDATE account SET password = NULL
               WHERE "providerId" = 'credential'
                 AND "userId" = (SELECT id FROM "user" WHERE email = ${email})`.execute(db);
    expect(await firstFactor(viaOAuth)).toBe('recent_sign_in');
    expect(await firstFactor(viaPassword)).toBe('sign_in_again');
    const pk = await registerSoftPasskey(req, viaPassword, await newSoftPasskey(), origin);
    expect(pk.status).toBe(403);
    expect(((await pk.json()) as { code: string }).code).toBe('recent_sign_in_required');
  });

  it('an account with a password still gives it, even right after an OAuth sign-in', async () => {
    const email = newEmail();
    const up = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Password Harness' }),
    });
    expect(up.ok).toBe(true);
    // Better Auth links a provider to an existing account only once its address is verified.
    await sql`UPDATE "user" SET "emailVerified" = true WHERE email = ${email}`.execute(db);
    const cookie = await oauthSignIn(email);
    expect(await firstFactor(cookie)).toBe('password');
    const pk = await registerSoftPasskey(req, cookie, await newSoftPasskey(), origin);
    expect(pk.status).toBe(403);
    expect(((await pk.json()) as { code: string }).code).toBe('password_required');
    expect((await enableTotp(cookie)).status).toBe(400);
    expect((await enableTotp(cookie, { password: PASSWORD })).status).toBe(200);
  });
});

/**
 * TOTP is accepted whenever it is enrolled, beside a passkey too (owner,
 * 2026-10-18): a passkey that cannot verify its user (a key with no PIN) does not
 * lock out an account that also has an authenticator app.
 */
d('god step-up on an account with a passkey and TOTP', () => {
  let app: Hono;
  let cookie: string;
  let totpURI: string;
  let pk: SoftPasskey;
  let origin: string;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: JSON.stringify(body),
    });
  const action = 'extension.license-rotate';

  beforeAll(async () => {
    const t = await getTestApp();
    app = t.app;
    origin = passkeyRelyingParty().origin;
    const req = (p: string, i?: RequestInit) => app.request(p, i);
    cookie = await createGodSession(app, t.db);
    pk = await newSoftPasskey();
    const reg = await registerSoftPasskey(req, cookie, pk, origin, { password: PASSWORD });
    expect(reg.status).toBe(200);
    const stepped = await passkeyStepUp(req, cookie, pk, 'factor.totp.add', origin);
    const en = await post(
      '/api/auth/two-factor/enable',
      { password: PASSWORD },
      { 'X-Zveltio-Step-Up': stepped },
    );
    expect(en.status).toBe(200);
    ({ totpURI } = (await en.json()) as { totpURI: string });
    const v = await post('/api/auth/two-factor/verify-totp', { code: totpCode(totpURI) });
    expect(v.status).toBe(200);
    // Confirming TOTP replaces the session.
    cookie =
      v.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ') || cookie;
  });

  it('options offer the passkey and say the app is accepted too', async () => {
    const o = (await (await post('/api/auth/step-up/options', { action })).json()) as {
      method: string;
      totp: boolean;
    };
    expect(o).toMatchObject({ method: 'passkey', totp: true });
  });

  it('a TOTP code mints a token beside a passkey, once', async () => {
    const code = totpCode(totpURI);
    const v = await post('/api/auth/step-up/verify', { action, code });
    expect(v.status).toBe(200);
    const { token, method } = (await v.json()) as { token: string; method: string };
    expect(method).toBe('totp');
    expect(
      (await post('/api/admin/license/rotate', {}, { 'X-Zveltio-Step-Up': token })).status,
    ).toBe(200);
    expect((await post('/api/auth/step-up/verify', { action, code })).status).toBe(403);
  });

  it('a passkey assertion without user verification is still refused, and points at the app', async () => {
    const o = await post('/api/auth/step-up/options', { action });
    const { options } = (await o.json()) as { options: { challenge: string; rpId: string } };
    const bare = await softAssertion(pk, options.challenge, options.rpId, origin, { uv: false });
    const v = await post('/api/auth/step-up/verify', { action, response: bare });
    expect(v.status).toBe(403);
    const body = (await v.json()) as { code: string; detail: string };
    expect(body.code).toBe('step_up_user_verification_required');
    expect(body.detail).toMatch(/authenticator app/);
  });
});

/**
 * A step-up proves who holds the session, not whose passkey the id names. The
 * owner check is Better Auth's (`requireResourceOwnership` on delete-passkey);
 * the engine's gate must not audit the refused removal as done.
 */
d('removing another account’s passkey', () => {
  it('is refused even with a step-up, and leaves the passkey and the audit untouched', async () => {
    const { app, db } = await getTestApp();
    const origin = passkeyRelyingParty().origin;
    const req = (path: string, init?: RequestInit) => app.request(path, init);
    const password = 'HarnessMember123!';
    const a = await createMemberSession(app, db);
    const b = await createMemberSession(app, db);
    const bKey = await newSoftPasskey();
    expect(
      (await registerSoftPasskey(req, a.cookie, await newSoftPasskey(), origin, { password }))
        .status,
    ).toBe(200);
    expect((await registerSoftPasskey(req, b.cookie, bKey, origin, { password })).status).toBe(200);
    const aPasskeys = () =>
      sql<{ id: string }>`SELECT id FROM passkey WHERE "userId" = ${a.userId}`.execute(db);
    const [target] = (await aPasskeys()).rows;
    const t = await passkeyStepUp(req, b.cookie, bKey, 'factor.passkey.remove', origin);
    const del = await app.request('/api/auth/passkey/delete-passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: b.cookie, 'X-Zveltio-Step-Up': t },
      body: JSON.stringify({ id: target!.id }),
    });
    expect(del.status).toBe(401);
    expect((await aPasskeys()).rows.map((r) => r.id)).toEqual([target!.id]);
    await _settleAuditWrites();
    const removed = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log
       WHERE event_type = 'auth.factor_changed' AND metadata->>'change' = 'passkey.remove'
         AND user_id IN (${a.userId}, ${b.userId})`.execute(db);
    expect(removed.rows[0]?.n).toBe(0);
  });
});

d('a passkey registered to another account', () => {
  it('does not verify a step-up, even though its signature is good', async () => {
    const { app, db } = await getTestApp();
    const origin = passkeyRelyingParty().origin;
    const req = (path: string, init?: RequestInit) => app.request(path, init);
    const password = 'HarnessMember123!';
    const a = await createMemberSession(app, db);
    const b = await createMemberSession(app, db);
    const aKey = await newSoftPasskey();
    expect((await registerSoftPasskey(req, a.cookie, aKey, origin, { password })).status).toBe(200);
    expect(
      (await registerSoftPasskey(req, b.cookie, await newSoftPasskey(), origin, { password }))
        .status,
    ).toBe(200);
    // B's session, B's challenge, A's authenticator.
    await expect(passkeyStepUp(req, b.cookie, aKey, 'factor.passkey.add', origin)).rejects.toThrow(
      'step-up verify: 403',
    );
    // A's own step-up with the same key still verifies.
    expect(await passkeyStepUp(req, a.cookie, aKey, 'factor.passkey.add', origin)).toBeString();
  });
});

/**
 * Only an OAuth sign-in marks a session as one that may enroll a first factor
 * without a password; any other session create (email sign-in, a refresh) must not.
 */
d('noteSessionOrigin', () => {
  it('records the OAuth sign-in paths and no other', async () => {
    await getTestApp();
    const noPasswordUser = crypto.randomUUID();
    const tokenFor = async (path: string | undefined) => {
      const t = `origin-probe-${crypto.randomUUID()}`;
      await noteSessionOrigin(t, path);
      return firstFactorRule(noPasswordUser, t);
    };
    for (const path of ['/sign-in/email', '/sign-up/email', '/get-session', undefined]) {
      expect(await tokenFor(path)).toBe('sign_in_again');
    }
    for (const path of ['/callback/:id', '/sign-in/social']) {
      expect(await tokenFor(path)).toBe('recent_sign_in');
    }
  });
});

/**
 * The signature counter (WebAuthn §6.1.1): a step-up assertion whose counter is
 * not above the stored one is a cloned authenticator or a replay. The challenge
 * is single-use; the counter is what refuses a stale assertion on a fresh one.
 */
d('passkey step-up signature counter', () => {
  it('advances on a good assertion and refuses one that does not exceed it', async () => {
    const { app, db } = await getTestApp();
    const origin = passkeyRelyingParty().origin;
    const req = (path: string, init?: RequestInit) => app.request(path, init);
    const m = await createMemberSession(app, db);
    const pk = await newSoftPasskey();
    const reg = await registerSoftPasskey(req, m.cookie, pk, origin, {
      password: 'HarnessMember123!',
    });
    expect(reg.status).toBe(200);
    const action = 'factor.passkey.add';
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, cookie: m.cookie },
        body: JSON.stringify(body),
      });
    /** A step-up whose assertion carries authenticator counter `n`. */
    const stepUpAt = async (n: number) => {
      const o = await post('/api/auth/step-up/options', { action });
      const { options } = (await o.json()) as { options: { challenge: string; rpId: string } };
      pk.counter = n - 1; // softAssertion increments before signing.
      const response = await softAssertion(pk, options.challenge, options.rpId, origin);
      return { response, res: await post('/api/auth/step-up/verify', { action, response }) };
    };
    const stored = async () =>
      (
        await sql<{
          counter: number;
        }>`SELECT counter FROM passkey WHERE "userId" = ${m.userId}`.execute(db)
      ).rows[0]?.counter;

    const good = await stepUpAt(5);
    expect(good.res.status).toBe(200);
    expect(await stored()).toBe(5);
    // The same assertion again: its challenge is spent.
    expect(
      (await post('/api/auth/step-up/verify', { action, response: good.response })).status,
    ).toBe(403);
    // Fresh challenges, counters equal to and below the stored one.
    for (const n of [5, 2]) {
      const stale = await stepUpAt(n);
      expect(stale.res.status).toBe(403);
      expect(((await stale.res.json()) as { code: string }).code).toBe('step_up_failed');
    }
    expect(await stored()).toBe(5);
    expect((await stepUpAt(6)).res.status).toBe(200);
    expect(await stored()).toBe(6);

    // Two assertions with the same counter, verified concurrently: both read the
    // stored 6 and both verify, but only one may advance it.
    const signed = async () => {
      const o = await post('/api/auth/step-up/options', { action });
      const { options } = (await o.json()) as { options: { challenge: string; rpId: string } };
      pk.counter = 6;
      return softAssertion(pk, options.challenge, options.rpId, origin);
    };
    const [r1, r2] = [await signed(), await signed()];
    const raced = await Promise.all(
      [r1, r2].map((response) => post('/api/auth/step-up/verify', { action, response })),
    );
    expect(raced.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(await stored()).toBe(7);
  });
});
