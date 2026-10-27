/**
 * Removing a sign-in factor or changing the password closes every step-up the
 * account holds (lib/step-up.ts `closeStepUps`): the configuration window and
 * any unspent token, on every session of the user.
 *
 * Before: both were rows keyed by the session alone. Deleting a passkey or
 * disabling TOTP left the window open for up to five minutes, on this session
 * and on the account's others, and a token minted with the factor just removed
 * stayed spendable — a step-up outlived what it proved.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { passkeyRelyingParty } from '../../lib/auth.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import {
  enrollTotp,
  newSoftPasskey,
  passkeyStepUp,
  registerSoftPasskey,
  type SoftPasskey,
  totpCode,
} from '../../testing/step-up.js';

const d = harnessAvailable() ? describe : describe.skip;
const PASSWORD = 'HarnessGod123!';

d('removing a factor or changing the password closes step-up', () => {
  let app: Hono;
  let db: Database;
  let origin: string;
  const req = (path: string, init?: RequestInit) => app.request(path, init);
  const post = (path: string, cookie: string, body: unknown, h: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, ...h },
      body: JSON.stringify(body),
    });
  /** A configuration mutation: 200 only with the session's window open. */
  const configure = (cookie: string) => post('/api/permissions/cache/invalidate', cookie, {});
  const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  const signIn = async (email: string, password = PASSWORD) =>
    cookieOf(await post('/api/auth/sign-in/email', '', { email, password }));
  const emailOf = async (cookie: string) =>
    ((await (await req('/api/me', { headers: { cookie } })).json()) as { user: { email: string } })
      .user.email;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    origin = passkeyRelyingParty().origin;
  });

  it('deleting a passkey closes the window on every session and spends unspent tokens', async () => {
    const a = await createGodSession(app, db, { factor: false });
    const [pk1, pk2] = [await newSoftPasskey(), await newSoftPasskey()];
    const stepUp = (cookie: string, pk: SoftPasskey, action: string) =>
      passkeyStepUp(req, cookie, pk, action, origin);
    expect((await registerSoftPasskey(req, a, pk1, origin, { password: PASSWORD })).status).toBe(
      200,
    );
    const add = await stepUp(a, pk1, 'factor.passkey.add');
    expect(
      (await registerSoftPasskey(req, a, pk2, origin, { headers: { 'X-Zveltio-Step-Up': add } }))
        .status,
    ).toBe(200);

    const b = await signIn(await emailOf(a));
    await stepUp(b, pk2, 'config');
    const spare = await stepUp(a, pk1, 'extension.license-rotate');
    const remove = await stepUp(a, pk1, 'factor.passkey.remove');
    expect((await configure(a)).status).toBe(200);
    expect((await configure(b)).status).toBe(200);

    const list = await req('/api/auth/passkey/list-user-passkeys', { headers: { cookie: a } });
    const ids = ((await list.json()) as { id: string; credentialID: string }[])
      .filter((p) => p.credentialID === Buffer.from(pk1.credentialId).toString('base64url'))
      .map((p) => p.id);
    expect(ids).toHaveLength(1);
    const del = await post(
      '/api/auth/passkey/delete-passkey',
      a,
      { id: ids[0] },
      { 'X-Zveltio-Step-Up': remove },
    );
    expect(del.status).toBe(200);

    for (const cookie of [a, b]) {
      const res = await configure(cookie);
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('step_up_required');
    }
    // A fresh step-up with the passkey that is left reopens the window, not the old token.
    await stepUp(a, pk2, 'config');
    const rotate = await post('/api/admin/license/rotate', a, {}, { 'X-Zveltio-Step-Up': spare });
    expect(rotate.status).toBe(403);
    expect(await codeOf(rotate)).toBe('step_up_required');
  });

  it('disabling TOTP closes the window its own step-up opened', async () => {
    const first = await createGodSession(app, db, { factor: false });
    const other = await signIn(await emailOf(first));
    const { cookie, totpURI } = await enrollTotp(req, first, PASSWORD);
    // Turning TOTP on ends every other session and keeps this one.
    expect((await req('/api/me', { headers: { cookie: other } })).status).toBe(401);
    expect((await req('/api/me', { headers: { cookie } })).status).toBe(200);
    const v = await post('/api/auth/step-up/verify', cookie, {
      action: 'factor.totp.disable',
      code: totpCode(totpURI),
    });
    expect(v.status).toBe(200);
    const { token } = (await v.json()) as { token: string };
    expect((await configure(cookie)).status).toBe(200);

    const off = await post(
      '/api/auth/two-factor/disable',
      cookie,
      { password: PASSWORD },
      { 'X-Zveltio-Step-Up': token },
    );
    expect(off.status).toBe(200);
    // Better Auth replaces the session on disable; the revocation of the others
    // in routes/index.ts spares the replacement, which has no window (and no factor).
    expect((await configure(cookie)).status).toBe(401);
    const fresh = await configure(cookieOf(off));
    expect(fresh.status).toBe(403);
    expect(await codeOf(fresh)).toBe('step_up_enrollment_required'); // no factor left
  });

  it('changing the password leaves no window: not on the old session, not on the new one', async () => {
    const old = await createGodSession(app, db);
    expect((await configure(old)).status).toBe(200);
    const res = await post('/api/auth/change-password', old, {
      currentPassword: PASSWORD,
      newPassword: 'HarnessGod456!',
    });
    expect(res.status).toBe(200);
    const fresh = cookieOf(res);
    expect((await configure(old)).status).toBe(401);
    const after = await configure(fresh);
    expect(after.status).toBe(403);
    expect(await codeOf(after)).toBe('step_up_required');
  });
});
