/**
 * `ctx.internals.deleteUser` / `revokeUserSessions` — offboarding as an
 * extension does it: inside the request's tenant transaction, as `zveltio_rls`.
 *
 * SCIM deprovisioning and GDPR erasure deleted the "user" row with raw SQL. As
 * `zveltio_rls` the `session` delete is refused (migration 044), so SCIM answered
 * 500 to every DELETE and `active=false`, and GDPR "skipped" it; either way no
 * session was revoked — with Valkey not even in principle, since better-auth
 * keeps sessions only there — and no `user.deleted` was audited.
 *
 * SCIM deactivation cleared the credential password, which left a passkey, a
 * magic link and OAuth signing the user in and could not be undone on
 * reactivation. `setUserActive` blocks and restores every method.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _internalForTests as authTesting, getAuth, initAuth } from '../../lib/auth.js';
import { CapabilityDeniedError, gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { createBetterAuthSession } from '../../lib/security/index.js';
import { getEnforcer } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';

d('extension offboarding through ctx.internals', () => {
  let app: Hono;
  let db: Database;
  const internals = gateInternals('auth/scim', buildExtensionInternals(), ['auth:users']);
  // Where an extension's handler runs: the request's tenant transaction.
  const asRequest = <T>(fn: (trx: Database) => Promise<T>) =>
    buildExtensionInternals().withTenantIsolation(TENANT, fn);

  const sessionUser = async (cookie: string) => {
    const res = await app.request('/api/auth/get-session', { headers: { cookie } });
    return ((await res.json().catch(() => null)) as { user?: { id: string } } | null)?.user?.id;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
  });

  it('deleteUser revokes the session, drops the grants and audits who and why', async () => {
    const { cookie, userId } = await createMemberSession(app, db);
    const e = await getEnforcer();
    await e.addGroupingPolicy(userId, 'admin', '*');
    expect(await sessionUser(cookie)).toBe(userId);

    const deleted = await asRequest((trx) =>
      internals.deleteUser(trx, userId, {
        actor: 'scim:token-1',
        reason: 'scim.deprovision',
        metadata: { tenant_id: TENANT },
      }),
    );

    expect(deleted).toBe(true);
    expect(await sessionUser(cookie)).toBeUndefined();
    const user = await sql`SELECT 1 FROM "user" WHERE id = ${userId}`.execute(db);
    expect(user.rows).toHaveLength(0);
    const grants = await sql`SELECT 1 FROM zvd_permissions WHERE v0 = ${userId}`.execute(db);
    expect(grants.rows).toHaveLength(0);
    expect(await e.getRolesForUser(userId, '*')).toEqual([]);
    const audit = await sql<{ user_id: string | null; metadata: Record<string, unknown> }>`
      SELECT user_id, metadata FROM zv_audit_log
       WHERE event_type = 'user.deleted' AND resource_id = ${userId}`.execute(db);
    expect(audit.rows).toEqual([
      {
        user_id: null,
        metadata: { actor: 'scim:token-1', reason: 'scim.deprovision', tenant_id: TENANT },
      },
    ]);
  });

  it('deleteUser of an id that is no user touches nothing', async () => {
    const ghost = `ghost_${crypto.randomUUID().slice(0, 8)}`;
    const e = await getEnforcer();
    await e.addPolicy(ghost, '*', `${ghost}_res`, 'read'); // a role, say
    try {
      const deleted = await asRequest((trx) =>
        internals.deleteUser(trx, ghost, { actor: 'scim:token-1', reason: 'scim.deprovision' }),
      );
      expect(deleted).toBe(false);
      expect(await e.getFilteredPolicy(0, ghost)).toEqual([[ghost, '*', `${ghost}_res`, 'read']]);
      const audit = await sql`SELECT 1 FROM zv_audit_log WHERE resource_id = ${ghost}`.execute(db);
      expect(audit.rows).toHaveLength(0);
    } finally {
      await e.deleteUser(ghost);
    }
  });

  it('revokeUserSessions ends the session and nothing else', async () => {
    const { cookie, userId, email } = await createMemberSession(app, db);
    expect(await sessionUser(cookie)).toBe(userId);

    await asRequest(() => internals.revokeUserSessions(userId));

    expect(await sessionUser(cookie)).toBeUndefined();
    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'HarnessMember123!' }),
    });
    expect(signIn.status).toBe(200);
  });

  it('setUserActive(false) refuses every way in; setUserActive(true) restores them', async () => {
    const { cookie, userId, email } = await createMemberSession(app, db);
    // A magic link to an unverified address first strips its unproven access —
    // not what this test is about.
    await sql`UPDATE "user" SET "emailVerified" = true WHERE id = ${userId}`.execute(db);
    expect(await sessionUser(cookie)).toBe(userId);

    // The engine's own auth config with mail configured, which is what turns on
    // the magic-link plugin. Put back to the harness's configuration below.
    const smtp = process.env.SMTP_HOST;
    const appAuth = getAuth();
    process.env.SMTP_HOST = '127.0.0.1';
    const auth = await initAuth(db);
    if (!auth) throw new Error('initAuth returned no instance');
    const authCtx = await auth.$context;

    const passwordSignIn = async () =>
      (
        await app.request('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'HarnessMember123!' }),
        })
      ).status;
    const magicLinkSignIn = async () => {
      const token = crypto.randomUUID().replaceAll('-', '');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      await authCtx.internalAdapter.createVerificationValue({
        identifier: Buffer.from(digest).toString('base64url'), // the plugin's `storeToken: 'hashed'`
        value: JSON.stringify({ email }),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const url = new URL(`/api/auth/magic-link/verify?token=${token}`, authCtx.baseURL);
      return (await auth.handler(new Request(url))).status;
    };

    try {
      await asRequest((trx) => internals.setUserActive(trx, userId, false));

      expect(await sessionUser(cookie)).toBeUndefined();
      expect(await passwordSignIn()).toBe(403);
      expect(await magicLinkSignIn()).toBe(403);
      // Passkey and OAuth create their session through this same adapter call.
      await expect(authCtx.internalAdapter.createSession(userId)).rejects.toThrow(
        'This account is disabled.',
      );
      // The SSO bridge (LDAP, SAML) inserts its own row.
      await expect(createBetterAuthSession(db, userId)).rejects.toThrow(
        'This account is disabled.',
      );
      const sessions = await sql`SELECT 1 FROM session WHERE "userId" = ${userId}`.execute(db);
      expect(sessions.rows).toHaveLength(0);

      await asRequest((trx) => internals.setUserActive(trx, userId, true));

      expect(await passwordSignIn()).toBe(200);
      expect(await magicLinkSignIn()).toBe(200);
    } finally {
      if (smtp === undefined) delete process.env.SMTP_HOST;
      else process.env.SMTP_HOST = smtp;
      authTesting.setAuthForTests(appAuth);
    }
  });

  it('an API key its creator made stops working while they are deactivated', async () => {
    const god = await createGodSession(app, db);
    const { userId } = await createMemberSession(app, db);
    const keyRes = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ name: `offboard ${Date.now()}`, scopes: [] }),
    });
    const { id: keyId, key } = (await keyRes.json()) as { id: string; key: string };
    // The route records the signed-in caller; this key is the member's.
    await sql`UPDATE zv_api_keys SET created_by = ${userId} WHERE id = ${keyId}`.execute(db);
    // 401 is the key refused; anything else (a scope-less key gets 403) got past it.
    const call = async () =>
      (await app.request('/api/data/zv_no_such_collection', { headers: { 'X-API-Key': key } }))
        .status;
    const wsUpgrade = async () =>
      (
        await app.request(
          '/api/ws',
          { headers: { 'X-API-Key': key } },
          { server: { upgrade: () => true } },
        )
      ).status;
    expect(await call()).not.toBe(401);

    await asRequest((trx) => internals.setUserActive(trx, userId, false));
    expect(await call()).toBe(401);
    expect(await wsUpgrade()).toBe(401);

    await asRequest((trx) => internals.setUserActive(trx, userId, true));
    expect(await call()).not.toBe(401);
  });

  it('refuses to deactivate or delete the instance owner, and changes nothing', async () => {
    const cookie = await createGodSession(app, db);
    const god = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;

    await expect(asRequest((trx) => internals.setUserActive(trx, god, false))).rejects.toThrow(
      'is the instance owner (god) and cannot be deactivated',
    );
    await expect(
      asRequest((trx) => internals.deleteUser(trx, god, { actor: 'scim:t', reason: 'x' })),
    ).rejects.toMatchObject({ code: 'user_protected' });

    const row = await sql<{ banned: boolean | null }>`
      SELECT banned FROM "user" WHERE id = ${god}`.execute(db);
    expect(row.rows).toEqual([{ banned: null }]);
    expect(await sessionUser(cookie)).toBe(god);
  });

  it('is refused to an extension that did not declare auth:users', () => {
    const bare = gateInternals('compliance/gdpr', buildExtensionInternals(), ['database']);
    expect(() => bare.revokeUserSessions('anyone')).toThrow(CapabilityDeniedError);
    expect(() => bare.setUserActive(db, 'anyone', false)).toThrow(CapabilityDeniedError);
    expect(() => bare.deleteUser(db, 'anyone', { reason: 'x' })).toThrow(CapabilityDeniedError);
  });
});
