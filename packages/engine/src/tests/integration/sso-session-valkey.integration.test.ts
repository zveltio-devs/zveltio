/**
 * `createBetterAuthSession` with Valkey configured — the production setup.
 *
 * better-auth is given a `secondaryStorage` there and, without
 * `storeSessionInDatabase`, keeps sessions ONLY in it: a `session` row the SSO
 * bridge inserted was never looked for, so an LDAP or SAML cookie read as signed
 * out even where the insert was allowed. `sso-session.test.ts` (harness) covers
 * the no-cache half. Skipped when TEST_VALKEY_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { _internalForTests as dbTesting, type Database, initDatabase } from '../../db/index.js';
import { _internalForTests as authTesting, getAuth, initAuth } from '../../lib/auth.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { initPermissions } from '../../lib/tenancy/index.js';
import { _setCacheForTests, getCache, initCache } from '../../lib/runtime/index.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const VALKEY_URL = process.env.TEST_VALKEY_URL;
const TENANT = '00000000-0000-0000-0000-000000000001';

describe.skipIf(!VALKEY_URL || !harnessAvailable())('createBetterAuthSession (live Valkey)', () => {
  let db: Database;
  let appAuth: ReturnType<typeof getAuth>;
  let previousDb: Database | null = null;
  let savedValkey: string | undefined;
  const internals = gateInternals('auth/saml', buildExtensionInternals(), ['auth:session']);
  const asRequest = <T>(fn: (trx: Database) => Promise<T>) =>
    buildExtensionInternals().withTenantIsolation(TENANT, fn);
  const signedInAs = async (setCookie: string) => {
    const headers = new Headers({ cookie: setCookie.split(';')[0] ?? '' });
    return (await getAuth().api.getSession({ headers }))?.user?.id;
  };

  beforeAll(async () => {
    await getTestApp();
    // Earlier files in this process (crud, webhooks, api-keys, permissions)
    // replace the global pool with initDatabase() and destroy it, and the
    // helper reads getDb(): take a live one, and bind the enforcer to it.
    previousDb = dbTesting.swapDbForTests(null);
    db = await initDatabase();
    await initPermissions(db);
    appAuth = getAuth();
    savedValkey = process.env.VALKEY_URL;
    process.env.VALKEY_URL = VALKEY_URL;
    await initCache();
    await initAuth(db); // now with `secondaryStorage`
  });

  afterAll(async () => {
    // The pools this file opened: CI's Postgres has no connections to spare,
    // and failure-injection later in the same process ran out.
    await authTesting.closeAuthPoolForTests();
    authTesting.setAuthForTests(appAuth);
    await db.destroy();
    dbTesting.swapDbForTests(previousDb);
    await getCache()?.quit();
    _setCacheForTests(null);
    if (savedValkey === undefined) delete process.env.VALKEY_URL;
    else process.env.VALKEY_URL = savedValkey;
  });

  it('an existing user is signed in, and a DB row alone would not be', async () => {
    const { app } = await getTestApp();
    const { userId } = await createMemberSession(app, db);
    const { setCookie, token } = await asRequest((trx) =>
      internals.createBetterAuthSession(trx, userId),
    );
    expect(await signedInAs(setCookie)).toBe(userId);
    expect(await getCache()?.exists(token)).toBe(1);
  });

  it('a user provisioned in the same transaction is signed in once it commits', async () => {
    const { userId, setCookie } = await asRequest(async (trx) => {
      const id = crypto.randomUUID();
      await sql`
        INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
        VALUES (${id}, ${`sso-${id}@test.local`}, 'SSO', true, NOW(), NOW())`.execute(trx);
      return { userId: id, ...(await internals.createBetterAuthSession(trx, id)) };
    });
    expect(await signedInAs(setCookie)).toBe(userId);
  });

  it('a user the caller rolled back to a savepoint gets no cached session', async () => {
    let token = '';
    let setCookie = '';
    await asRequest(async (trx) => {
      await sql`SAVEPOINT sso`.execute(trx);
      const id = crypto.randomUUID();
      await sql`
        INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
        VALUES (${id}, ${`sso-${id}@test.local`}, 'SSO', true, NOW(), NOW())`.execute(trx);
      ({ token, setCookie } = await internals.createBetterAuthSession(trx, id));
      await sql`ROLLBACK TO SAVEPOINT sso`.execute(trx);
    });
    // No row stops a cache-only write: only the post-commit recheck does.
    expect(await getCache()?.exists(token)).toBe(0);
    expect(await signedInAs(setCookie)).toBeUndefined();
  });

  it('replaceExisting ends the previous session in the cache too', async () => {
    const { app } = await getTestApp();
    const { userId } = await createMemberSession(app, db);
    const first = await asRequest((trx) => internals.createBetterAuthSession(trx, userId));
    const second = await asRequest((trx) =>
      internals.createBetterAuthSession(trx, userId, { replaceExisting: true }),
    );
    expect(await signedInAs(first.setCookie)).toBeUndefined();
    expect(await signedInAs(second.setCookie)).toBe(userId);
  });

  it('refuses a deactivated user', async () => {
    const { app } = await getTestApp();
    const { userId } = await createMemberSession(app, db);
    await sql`UPDATE "user" SET banned = true WHERE id = ${userId}`.execute(db);
    await expect(
      asRequest((trx) => internals.createBetterAuthSession(trx, userId)),
    ).rejects.toMatchObject({ code: 'account_disabled' });
  });
});
