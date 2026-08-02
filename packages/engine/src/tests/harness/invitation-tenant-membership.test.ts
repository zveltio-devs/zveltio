/**
 * Accepting an invitation must make the user a member of the tenant that
 * issued it.
 *
 * Accepting set the global `user.role` and consumed the invitation, and that
 * was all. `zv_invitations.tenant_id` has existed since migration 021 and
 * nothing read it, so no `zv_tenant_users` row was ever created — while the
 * membership gate is on by default and answers 403 to every /api/* and
 * /ext/* request from a non-member. The invited user could sign in, saw a
 * fully rendered admin UI, and every request it made failed. The invitation
 * flow looked complete from both ends and worked from neither.
 *
 * Asserted against the real tables because the missing row is the whole bug.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const STAMP = Date.now();
const TENANT_ID = '00000000-0000-0000-0000-0000000000fd';
const TOKEN = `invtok${'0'.repeat(26)}${STAMP}`.slice(0, 48);
const EMAIL = `invitee-${STAMP}@example.test`;
const PASSWORD = 'correct horse battery staple';

d('accepting an invitation joins the tenant', () => {
  let app: Hono;
  let db: Database;
  let userId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await sql`
      INSERT INTO zv_tenants (id, name, slug, status)
      VALUES (${TENANT_ID}::uuid, ${`Invite Co ${STAMP}`}, ${`invite-co-${STAMP}`}, 'active')
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
    await sql`
      INSERT INTO zv_invitations (email, name, role, token, expires_at, tenant_id)
      VALUES (${EMAIL}, 'Invited Person', 'member', ${TOKEN},
              NOW() + INTERVAL '7 days', ${TENANT_ID}::uuid)
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${TENANT_ID}::uuid`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_invitations WHERE token = ${TOKEN}`.execute(db).catch(() => {});
    if (userId) {
      await sql`DELETE FROM "account" WHERE "userId" = ${userId}`.execute(db).catch(() => {});
      await sql`DELETE FROM "session" WHERE "userId" = ${userId}`.execute(db).catch(() => {});
      await sql`DELETE FROM "user" WHERE id = ${userId}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT_ID}::uuid`.execute(db).catch(() => {});
  });

  it('creates the membership row in the inviting tenant', async () => {
    const res = await app.request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, password: PASSWORD, name: 'Invited Person' }),
    });
    expect(res.status).toBe(201);
    userId = ((await res.json()) as { user: { id: string } }).user.id;

    const membership = await db
      .selectFrom('zv_tenant_users')
      .select(['tenant_id', 'role'])
      .where('user_id', '=', userId)
      .where('tenant_id', '=', TENANT_ID)
      .executeTakeFirst();

    // This row is what the membership gate looks for. It was never written.
    expect(membership).toBeDefined();
    expect(membership?.role).toBe('member');
  });

  it('still applies the invited role and consumes the invitation', async () => {
    const invite = await db
      .selectFrom('zv_invitations')
      .select(['accepted_at', 'accepted_by'])
      .where('token', '=', TOKEN)
      .executeTakeFirst();
    expect(invite?.accepted_at).not.toBeNull();
    expect(invite?.accepted_by).toBe(userId);

    const user = await db
      .selectFrom('user')
      .select('role')
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(user?.role).toBe('member');
  });
});
