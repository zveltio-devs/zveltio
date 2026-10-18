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
import { passkeyRelyingParty } from '../../lib/auth.js';
import {
  createGodSession,
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
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_extension_registry WHERE name LIKE 'stepup-probe%'`.execute(db);
  });

  it('a god with no factor is told to enroll one', async () => {
    const res = await config(PROBE);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('step_up_enrollment_required');
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
    const after = await config(PROBE);
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
});
