/**
 * An invitation link must not be recoverable from the database.
 *
 * `zv_invitations.token` held the raw token, and `user.invited` audit rows
 * carried it as `resource_id`, so one SELECT — or a backup — was every live
 * invitation link: open one, set a password, join the tenant at the invited
 * role. Reset and verification tokens were already stored hashed
 * (`verification: { storeIdentifier: 'hashed' }` in lib/auth.ts); invitations
 * were the remaining plaintext credential. Migration 038 hashes the rows that
 * already exist and moves the audit reference to the invitation id.
 *
 * The digest is computed here with node:crypto, not with the engine's helper,
 * so a helper that silently stored the input would fail this test.
 */

import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const sha256 = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

d('invitation token at rest', () => {
  it('stores only a digest; the stored value is not a link, the issued one is', async () => {
    const { app, db } = await getTestApp();
    const cookie = await createGodSession(app, db);
    const email = `inv-rest-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;

    const invited = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ email, name: 'Invitee', role: 'member' }),
    });
    expect(invited.status).toBe(201);
    const { invite_url } = (await invited.json()) as { invite_url: string };
    const token = new URL(invite_url).searchParams.get('token') ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const row = await sql<{ id: string; token: string }>`
      SELECT id::text, token FROM zv_invitations WHERE email = ${email}
    `.execute(db);
    expect(row.rows[0]!.token).toBe(sha256(token));

    const leaked = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM zv_audit_log
       WHERE resource_id = ${token} OR metadata::text LIKE ${`%${token}%`}
    `.execute(db);
    expect(leaked.rows[0]!.n).toBe(0);
    const audited = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM zv_audit_log
       WHERE event_type = 'user.invited' AND resource_id = ${row.rows[0]!.id}
    `.execute(db);
    expect(audited.rows[0]!.n).toBe(1);

    // What a database reader holds opens nothing.
    expect((await app.request(`/api/invitations/${row.rows[0]!.token}`)).status).toBe(404);
    const replay = await app.request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: row.rows[0]!.token, password: 'Test12345' }),
    });
    expect(replay.status).toBe(404);

    // The link the invitee received still works end to end.
    expect((await app.request(`/api/invitations/${token}`)).status).toBe(200);
    const accepted = await app.request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'Test12345' }),
    });
    expect(accepted.status).toBe(201);
  }, 30_000);

  it('migration 038 hashes a pending pre-038 invitation and re-points its audit row', async () => {
    const { db } = await getTestApp();
    const plain = `legacy-${Date.now()}-${'a'.repeat(40)}`;
    const email = `inv-legacy-${Date.now()}@test.local`;
    const file = Bun.file(
      new URL('../../db/migrations/sql/038_hash_invitation_tokens.sql', import.meta.url),
    );
    const up = parseMigrationFile(await file.text()).up;

    // Rolled back so the shared harness database keeps its own state.
    const ROLLBACK = new Error('rollback');
    let seen: { token: string; resource_id: string; id: string } | undefined;
    await db
      .transaction()
      .execute(async (trx) => {
        const ins = await sql<{ id: string }>`
          INSERT INTO zv_invitations (email, role, token, expires_at)
          VALUES (${email}, 'member', ${plain}, NOW() + INTERVAL '1 day')
          RETURNING id::text
        `.execute(trx);
        await sql`
          INSERT INTO zv_audit_log (event_type, resource_id, resource_type, created_at)
          VALUES ('user.invited', ${plain}, 'invitation', NOW())
        `.execute(trx);
        await sql.raw(up).execute(trx);
        // Twice: a rerun must not hash a digest again.
        await sql.raw(up).execute(trx);
        const r = await sql<{ token: string; resource_id: string }>`
          SELECT i.token,
                 (SELECT a.resource_id FROM zv_audit_log a
                   WHERE a.event_type = 'user.invited'
                     AND a.resource_id IN (${plain}, ${ins.rows[0]!.id})) AS resource_id
            FROM zv_invitations i WHERE i.email = ${email}
        `.execute(trx);
        seen = { ...r.rows[0]!, id: ins.rows[0]!.id };
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });

    expect(seen?.token).toBe(sha256(plain));
    expect(seen?.resource_id).toBe(seen?.id);
  }, 30_000);
});
