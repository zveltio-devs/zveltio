/**
 * POST /api/users/:id/factors/reset — an administrator clears a user's passkeys
 * and TOTP, for a user who lost them. Before: the only way back for that user was
 * the RECOVERY_TOKEN bootstrap, which exists for god alone.
 *
 * God resets anyone but itself; an instance admin resets ordinary users only. The
 * actor confirms with a step-up bound to `user.factors.reset:<id>`; the target's
 * sessions end with its factors, as on deactivation.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { passkeyRelyingParty } from '../../lib/auth.js';
import {
  DEFAULT_TENANT_ID,
  getEnforcer,
  invalidateUserPermCache,
} from '../../lib/tenancy/index.js';
import {
  createMemberSession,
  createSteppedUpGod,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import {
  enrollTotp,
  newSoftPasskey,
  passkeyStepUp,
  registerSoftPasskey,
  totpCode,
} from '../../testing/step-up.js';

const d = harnessAvailable() ? describe : describe.skip;
const MEMBER_PASSWORD = 'HarnessMember123!';

d('admin factor reset', () => {
  let app: Hono;
  let db: Database;
  let origin: string;
  let god: Awaited<ReturnType<typeof createSteppedUpGod>>;
  let godId: string;
  const req = (path: string, init?: RequestInit) => app.request(path, init);

  /** A member, or an instance admin; with a passkey when `stepUp` is asked for. */
  const person = async (opts: { admin?: boolean; passkey?: boolean } = {}) => {
    const m = await createMemberSession(app, db);
    if (opts.admin) {
      await (await getEnforcer()).addRoleForUser(m.userId, 'admin', DEFAULT_TENANT_ID);
      await invalidateUserPermCache(m.userId);
    }
    const pk = await newSoftPasskey();
    if (opts.passkey) {
      const reg = await registerSoftPasskey(req, m.cookie, pk, origin, {
        password: MEMBER_PASSWORD,
      });
      if (!reg.ok) throw new Error(`passkey: ${reg.status} ${await reg.text()}`);
    }
    return {
      ...m,
      stepUp: async (action: string) => ({
        'X-Zveltio-Step-Up': await passkeyStepUp(req, m.cookie, pk, action, origin),
      }),
    };
  };

  /** A member with both factors: TOTP first (behind the password), then a passkey. */
  const enrolled = async () => {
    const m = await createMemberSession(app, db);
    const { cookie, totpURI } = await enrollTotp(req, m.cookie, MEMBER_PASSWORD);
    const v = await req('/api/auth/step-up/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'factor.passkey.add', code: totpCode(totpURI) }),
    });
    const { token } = (await v.json()) as { token: string };
    const reg = await registerSoftPasskey(req, cookie, await newSoftPasskey(), origin, {
      headers: { 'X-Zveltio-Step-Up': token },
    });
    if (!reg.ok) throw new Error(`second factor: ${reg.status} ${await reg.text()}`);
    return { ...m, cookie };
  };

  const factorsOf = async (userId: string) =>
    (
      await sql<{ passkeys: number; totp: number; enabled: boolean }>`
        SELECT (SELECT count(*)::int FROM passkey WHERE "userId" = ${userId}) AS passkeys,
               (SELECT count(*)::int FROM "twoFactor" WHERE "userId" = ${userId}) AS totp,
               (SELECT "twoFactorEnabled" FROM "user" WHERE id = ${userId}) AS enabled`.execute(db)
    ).rows[0];

  const reset = (id: string, cookie: string, headers: Record<string, string> = {}) =>
    req(`/api/users/${id}/factors/reset`, { method: 'POST', headers: { cookie, ...headers } });
  const action = (id: string) => `user.factors.reset:${id}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    origin = passkeyRelyingParty().origin;
    god = await createSteppedUpGod(app, db);
    const me = await req('/api/me', { headers: { cookie: god.cookie } });
    godId = ((await me.json()) as { user: { id: string } }).user.id;
  });

  it('god resets a member: factors gone, sessions ended, audited', async () => {
    const target = await enrolled();
    expect(await factorsOf(target.userId)).toEqual({ passkeys: 1, totp: 1, enabled: true });

    const res = await reset(target.userId, god.cookie, await god.stepUp(action(target.userId)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passkeys: 1, totp: 1 });
    expect(await factorsOf(target.userId)).toEqual({ passkeys: 0, totp: 0, enabled: false });

    const me = await req('/api/me', { headers: { cookie: target.cookie } });
    expect(me.status).toBe(401);

    const audit = await sql<{ user_id: string; metadata: Record<string, unknown> }>`
      SELECT user_id, metadata FROM zv_audit_log
       WHERE event_type = 'auth.factor_changed' AND resource_id = ${target.userId}
         AND metadata->>'change' = 'admin.reset'`.execute(db);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.user_id).toBe(godId);
    expect(audit.rows[0]?.metadata).toMatchObject({
      confirmed_by: 'passkey',
      passkeys: 1,
      totp: 1,
    });
  });

  it('an instance admin resets a member', async () => {
    const admin = await person({ admin: true, passkey: true });
    const target = await enrolled();
    const res = await reset(target.userId, admin.cookie, await admin.stepUp(action(target.userId)));
    expect(res.status).toBe(200);
    expect(await factorsOf(target.userId)).toEqual({ passkeys: 0, totp: 0, enabled: false });
  });

  it('an instance admin may not reset another admin, nor god', async () => {
    const admin = await person({ admin: true, passkey: true });
    const other = await person({ admin: true, passkey: true });
    for (const id of [other.userId, godId]) {
      const res = await reset(id, admin.cookie, await admin.stepUp(action(id)));
      expect(res.status).toBe(403);
    }
    expect((await factorsOf(other.userId))?.passkeys).toBe(1);
    expect((await factorsOf(godId))?.passkeys).toBe(1);
  });

  it('god may not reset itself', async () => {
    const res = await reset(godId, god.cookie, await god.stepUp(action(godId)));
    expect(res.status).toBe(403);
    expect((await factorsOf(godId))?.passkeys).toBe(1);
  });

  it('without a step-up, or with one for another action, nothing is reset', async () => {
    const target = await enrolled();
    const none = await reset(target.userId, god.cookie);
    expect(none.status).toBe(403);
    expect(((await none.json()) as { code: string }).code).toBe('step_up_required');

    const wrong = await reset(target.userId, god.cookie, await god.stepUp(action(godId)));
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { code: string }).code).toBe('step_up_required');
    expect(await factorsOf(target.userId)).toEqual({ passkeys: 1, totp: 1, enabled: true });
  });

  it('an actor with no factor is sent to enroll one', async () => {
    const admin = await person({ admin: true });
    const target = await enrolled();
    const res = await reset(target.userId, admin.cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('step_up_enrollment_required');
  });

  it('an unknown user is 404', async () => {
    const res = await reset('no-such-user', god.cookie, await god.stepUp(action('no-such-user')));
    expect(res.status).toBe(404);
  });
});
