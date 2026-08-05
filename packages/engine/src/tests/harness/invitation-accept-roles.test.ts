/**
 * Accepting an invitation, for every role the invite endpoint offers.
 *
 * `POST /api/users/invite` validates `z.enum(['admin','manager','member'])`.
 * Accepting then wrote that value into `user.role` — a column migration 052
 * had already reduced to `'god' | 'member'`, because "all other roles are
 * Casbin-only concepts". So two of the three choices violated
 * `user_role_check` and every acceptance of them died with a 500.
 *
 * The damage was not a broken button. `signUpEmail` runs BEFORE the
 * transaction, so the account survived the rollback: the invitee got a working
 * sign-in, no tenant membership, and an invitation still marked unconsumed and
 * therefore replayable. An operator inviting a colleague as admin — the normal
 * way to onboard one — produced exactly that.
 *
 * Existing tests covered `member`, which was the one value that happened to be
 * legal in both places. This one runs all three, and asserts on the state left
 * behind rather than the status code, because a 500 with a half-written
 * account is worse than a clean refusal and the status alone cannot tell them
 * apart.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('POST /api/invitations/accept', () => {
  for (const role of ['member', 'manager', 'admin'] as const) {
    it(`completes for an invitation issued as "${role}"`, async () => {
      const { app, db } = await getTestApp();
      const cookie = await createGodSession(app, db);
      const email = `inv-${role}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;

      const invited = await app.request('/api/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ email, name: 'Invitee', role }),
      });
      expect(invited.status).toBe(201);

      const row = await sql<{ token: string }>`
        SELECT token FROM zv_invitations WHERE email = ${email} LIMIT 1
      `.execute(db);
      const token = row.rows[0]?.token;
      expect(token).toBeTruthy();

      const accepted = await app.request('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'Test12345', name: 'Invitee' }),
      });
      expect(accepted.status).toBe(201);

      // The three pieces of state that were left inconsistent by the 500. The
      // membership one matters most: without it the membership gate answers 403
      // to every request the new user makes, so they can sign in and do nothing.
      const state = await sql<{
        members: number;
        consumed: boolean;
        db_role: string;
      }>`
        SELECT
          (SELECT COUNT(*)::int FROM zv_tenant_users m
             JOIN "user" u ON u.id = m.user_id WHERE u.email = ${email}) AS members,
          (SELECT accepted_at IS NOT NULL FROM zv_invitations WHERE email = ${email}) AS consumed,
          (SELECT role FROM "user" WHERE email = ${email}) AS db_role
      `.execute(db);
      const s = state.rows[0]!;

      expect(s.members).toBe(1);
      expect(s.consumed).toBe(true);
      // Never the invitation's role: that column holds only 'god' or 'member',
      // and writing anything else is what crashed the endpoint.
      expect(['god', 'member']).toContain(s.db_role);
    }, 30_000);
  }

  it('grants a Casbin role for every invitable name, not just membership grades', async () => {
    // `manager` is not one of MEMBERSHIP_ROLES, so the Casbin bridge skipped it
    // entirely: the invitee joined the tenant and received no authorization at
    // all, which reads as a permissions bug rather than a missing grant.
    const { app, db } = await getTestApp();
    const cookie = await createGodSession(app, db);
    const email = `inv-cas-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;

    await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ email, name: 'Invitee', role: 'manager' }),
    });
    const row = await sql<{ token: string }>`
      SELECT token FROM zv_invitations WHERE email = ${email} LIMIT 1
    `.execute(db);

    const res = await app.request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: row.rows[0]!.token, password: 'Test12345' }),
    });
    expect(res.status).toBe(201);

    const grants = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM zvd_permissions p
        JOIN "user" u ON u.id = p.v0
       WHERE u.email = ${email} AND p.ptype = 'g'
    `.execute(db);
    expect(grants.rows[0]!.n).toBeGreaterThan(0);
  }, 30_000);
});
