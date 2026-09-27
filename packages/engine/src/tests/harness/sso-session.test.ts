/**
 * `ctx.internals.createBetterAuthSession` — signing in a user an SSO extension
 * verified, the way LDAP and SAML call it: inside the request's tenant
 * transaction, as `zveltio_rls`, often on a user that transaction just created.
 *
 * It inserted the `session` row on that transaction, and `zveltio_rls` has had no
 * grant on `session` since migration 044: every LDAP and SAML login answered 500
 * (`permission denied for table session`). The Valkey half — better-auth reads a
 * session only from its cache there — is `sso-session-valkey.integration.test.ts`.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';

d('createBetterAuthSession through ctx.internals (no cache)', () => {
  let app: Hono;
  let db: Database;
  const internals = gateInternals('auth/ldap', buildExtensionInternals(), ['auth:session']);
  const asRequest = <T>(fn: (trx: Database) => Promise<T>) =>
    buildExtensionInternals().withTenantIsolation(TENANT, fn);
  const signedInAs = async (setCookie: string) => {
    const cookie = setCookie.split(';')[0] ?? '';
    const res = await app.request('/api/auth/get-session', { headers: { cookie } });
    return ((await res.json().catch(() => null)) as { user?: { id: string } } | null)?.user?.id;
  };
  // What `findOrCreateSsoUser` does in both extensions.
  const provision = async (trx: Database) => {
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
      VALUES (${id}, ${`sso-${id}@test.local`}, 'SSO', true, NOW(), NOW())`.execute(trx);
    return id;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
  });

  it('signs in an existing user from inside the request transaction', async () => {
    const { userId } = await createMemberSession(app, db);
    const { setCookie } = await asRequest((trx) =>
      internals.createBetterAuthSession(trx, userId, { userAgent: 'ldap-test' }),
    );
    expect(await signedInAs(setCookie)).toBe(userId);
  });

  it('signs in a user the same transaction provisioned, once it commits', async () => {
    const { userId, setCookie } = await asRequest(async (trx) => {
      const id = await provision(trx);
      return { userId: id, ...(await internals.createBetterAuthSession(trx, id)) };
    });
    expect(await signedInAs(setCookie)).toBe(userId);
  });

  it('leaves no session behind when that transaction rolls back', async () => {
    let userId = '';
    let setCookie = '';
    await expect(
      asRequest(async (trx) => {
        userId = await provision(trx);
        ({ setCookie } = await internals.createBetterAuthSession(trx, userId));
        throw new Error('audit write failed');
      }),
    ).rejects.toThrow('audit write failed');
    expect(await signedInAs(setCookie)).toBeUndefined();
    const rows = await sql`SELECT 1 FROM session WHERE "userId" = ${userId}`.execute(db);
    expect(rows.rows).toHaveLength(0);
  });

  it('replaceExisting ends the previous SSO session', async () => {
    const { userId } = await createMemberSession(app, db);
    const first = await asRequest((trx) => internals.createBetterAuthSession(trx, userId));
    const second = await asRequest((trx) =>
      internals.createBetterAuthSession(trx, userId, { replaceExisting: true }),
    );
    expect(await signedInAs(first.setCookie)).toBeUndefined();
    expect(await signedInAs(second.setCookie)).toBe(userId);
  });

  it('replaceExisting in a request that rolls back leaves the old session signed in', async () => {
    const { cookie, userId } = await createMemberSession(app, db);
    await expect(
      asRequest(async (trx) => {
        await internals.createBetterAuthSession(trx, userId, { replaceExisting: true });
        throw new Error('audit write failed');
      }),
    ).rejects.toThrow('audit write failed');
    expect(await signedInAs(cookie)).toBe(userId);
  });

  it('refuses a deactivated user with account_disabled and writes nothing', async () => {
    const { userId } = await createMemberSession(app, db);
    await sql`UPDATE "user" SET banned = true WHERE id = ${userId}`.execute(db);
    await sql`DELETE FROM session WHERE "userId" = ${userId}`.execute(db);
    await expect(
      asRequest((trx) => internals.createBetterAuthSession(trx, userId)),
    ).rejects.toMatchObject({ code: 'account_disabled' });
    const rows = await sql`SELECT 1 FROM session WHERE "userId" = ${userId}`.execute(db);
    expect(rows.rows).toHaveLength(0);
  });
});
