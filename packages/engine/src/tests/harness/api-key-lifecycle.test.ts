/**
 * A user's API keys end with the events that lock the user out.
 *
 * Only deleting the user deactivated their keys. Password reset, an
 * administrator's factor reset, "revoke all sessions" and a ban ended the
 * sessions and left every key the user had issued working — the ban hid them
 * only while it lasted (`apiKeyUsable` refuses a banned issuer), so lifting it
 * brought them back. Each event now sets the keys inactive, and nothing turns
 * them back on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import {
  asKeyIssuer,
  createMemberSession,
  createSteppedUpGod,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `keylife-${crypto.randomUUID().slice(0, 8)}`;

d('API keys end with the lockout events (ADR 0010 item 5)', () => {
  let app: Hono;
  let db: Database;
  const internals = gateInternals('auth/scim', buildExtensionInternals(), ['auth:users']);
  const asRequest = <T>(fn: (trx: Database) => Promise<T>) =>
    buildExtensionInternals().withTenantIsolation(DEFAULT_TENANT_ID, fn);

  /** A member who has issued a key — as `POST /api/api-keys` records it. */
  async function memberWithKey() {
    const m = await createMemberSession(app, db);
    await asKeyIssuer(m.userId);
    const key = generateApiKey();
    await db
      .insertInto('zv_api_keys')
      .values({
        name: NAME,
        key_hash: await hashApiKey(key),
        key_prefix: key.substring(0, 12),
        scopes: sql`${JSON.stringify([{ collection: '$schema', actions: ['read'] }])}::jsonb`,
        created_by: m.userId,
        is_active: true,
        tenant_id: DEFAULT_TENANT_ID,
      } as never)
      .execute();
    const status = async () =>
      (await app.request('/api/collections', { headers: { 'X-API-Key': key } })).status;
    expect(await status()).toBe(200);
    return { ...m, status };
  }

  const revokedAudit = async (userId: string) =>
    (
      await sql<{ metadata: { count: number } }>`
        SELECT metadata FROM zv_audit_log
         WHERE event_type = 'api_key.revoked' AND resource_type = 'user'
           AND resource_id = ${userId}`.execute(db)
    ).rows.map((r) => r.metadata.count);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_api_keys WHERE name = ${NAME}`.execute(db).catch(() => {});
  });

  it('password reset', async () => {
    const m = await memberWithKey();
    const token = crypto.randomUUID().replaceAll('-', '');
    const ctx = await getAuth().$context;
    await ctx.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: m.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // A token that is not one revokes nothing.
    const bogus = await app.request('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: 'HarnessReset123!', token: `${token}x` }),
    });
    expect(bogus.status).toBe(400);
    expect(await m.status()).toBe(200);

    const res = await app.request('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: 'HarnessReset123!', token }),
    });
    expect(res.status).toBe(200);
    expect(await m.status()).toBe(401);
    expect(await revokedAudit(m.userId)).toEqual([1]);
  });

  it("an administrator's factor reset", async () => {
    const god = await createSteppedUpGod(app, db);
    const m = await memberWithKey();
    const action = `user.factors.reset:${m.userId}`;
    const res = await app.request(`/api/users/${m.userId}/factors/reset`, {
      method: 'POST',
      headers: { cookie: god.cookie, ...(await god.stepUp(action)) },
    });
    expect(res.status).toBe(200);
    expect(await m.status()).toBe(401);
  });

  it('revoke all sessions — the user, and an extension', async () => {
    const own = await memberWithKey();
    const res = await app.request('/api/auth/revoke-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: own.cookie },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await own.status()).toBe(401);

    const ext = await memberWithKey();
    await asRequest(() => internals.revokeUserSessions(ext.userId));
    expect(await ext.status()).toBe(401);
  });

  it('sign out everywhere else', async () => {
    const m = await memberWithKey();
    const res = await app.request('/api/auth/revoke-other-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: m.cookie },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await m.status()).toBe(401);
  });

  it('not a password change, even one that signs out the other sessions', async () => {
    const m = await memberWithKey();
    const res = await app.request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: m.cookie },
      body: JSON.stringify({
        currentPassword: 'HarnessMember123!',
        newPassword: 'HarnessChanged123!',
        revokeOtherSessions: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(await m.status()).toBe(200);
  });

  it('a ban, and lifting it does not bring the keys back', async () => {
    const m = await memberWithKey();
    await asRequest((trx) => internals.setUserActive(trx, m.userId, false));
    expect(await m.status()).toBe(401);
    expect(await revokedAudit(m.userId)).toEqual([1]);

    await asRequest((trx) => internals.liftOwnBan(trx, m.userId));
    expect(await m.status()).toBe(401);
    await asRequest((trx) => internals.setUserActive(trx, m.userId, true));
    expect(await m.status()).toBe(401);
  });
});
