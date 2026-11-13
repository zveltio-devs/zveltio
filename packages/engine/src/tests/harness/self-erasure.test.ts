/**
 * `DELETE /api/me` — a person erases their own account (ADR 0046 decision 1).
 *
 * Before: no engine route did it. `compliance/gdpr` erased through
 * `ctx.internals.deleteUser`, which let an extension delete any account id it
 * named. Now the engine does it for the caller only, re-authenticated in the
 * request, through the same `deleteUser` as the admin route.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { generateApiKey, hashApiKey } from '../../lib/security/api-key-hash.js';
import { noteSessionOrigin } from '../../lib/step-up.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PASSWORD = 'HarnessMember123!';

d('DELETE /api/me erases the caller’s own account (ADR 0046)', () => {
  let app: Hono;
  let db: Database;

  const erase = (headers: Record<string, string>, body?: unknown) =>
    app.request('/api/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;
  const exists = async (id: string) =>
    (await sql`SELECT 1 FROM "user" WHERE id = ${id}`.execute(db)).rows.length === 1;
  const me = (cookie: string) => app.request('/api/me', { headers: { cookie } });
  const signIn = async (email: string) => {
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
  const mintKey = async (issuer: string) => {
    const raw = generateApiKey();
    await sql`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id, created_by)
      VALUES ('self-erasure probe', ${await hashApiKey(raw)}, 'zvk_', '[]'::jsonb, 100, true,
              ${DEFAULT_TENANT_ID}::uuid, ${issuer})`.execute(db);
    return raw;
  };
  const keyWorks = async (raw: string) =>
    (await app.request('/api/api-keys/self', { headers: { 'X-API-Key': raw } })).status === 200;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
  });

  it('refuses without the password, and with a wrong one', async () => {
    const m = await createMemberSession(app, db);
    const none = await erase({ cookie: m.cookie });
    expect(none.status).toBe(403);
    expect(await codeOf(none)).toBe('password_required');
    const wrong = await erase({ cookie: m.cookie }, { password: 'not-the-password' });
    expect(wrong.status).toBe(403);
    expect(await codeOf(wrong)).toBe('password_required');
    expect(await exists(m.userId)).toBe(true);
  });

  it('refuses without a session, and to an API key', async () => {
    const m = await createMemberSession(app, db);
    const raw = await mintKey(m.userId);
    expect(await keyWorks(raw)).toBe(true);
    expect((await erase({}, { password: PASSWORD })).status).toBe(401);
    for (const h of [{ 'X-API-Key': raw }, { Authorization: `Bearer ${raw}` }] as Record<
      string,
      string
    >[]) {
      // `refuseWithoutSession`: a key is told a session is required (403).
      const res = await erase(h, { password: PASSWORD });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { detail: string }).detail).toBe('Session required');
    }
    expect(await exists(m.userId)).toBe(true);
  });

  it('refuses the instance owner (god) with user_protected', async () => {
    const cookie = await createGodSession(app, db, { factor: false });
    const { id } = ((await (await me(cookie)).json()) as { user: { id: string } }).user;
    const res = await erase({ cookie }, { password: 'HarnessGod123!' });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('user_protected');
    expect(await exists(id)).toBe(true);
  });

  it('erases the caller only: every session and key stops, the row goes, user.deleted says self', async () => {
    const other = await createMemberSession(app, db);
    const m = await createMemberSession(app, db);
    const second = await signIn(m.email);
    const raw = await mintKey(m.userId);
    expect((await me(second)).status).toBe(200);
    expect(await keyWorks(raw)).toBe(true);

    // Nothing in the request names whom to erase: an id is refused, not followed.
    const aimed = await erase({ cookie: m.cookie }, { password: PASSWORD, user_id: other.userId });
    expect(aimed.status).toBe(400);
    expect(
      (
        await app.request(`/api/me/${other.userId}`, {
          method: 'DELETE',
          headers: { cookie: m.cookie },
        })
      ).status,
    ).toBe(404);

    const erasureId = crypto.randomUUID();
    const res = await erase({ cookie: m.cookie }, { password: PASSWORD, erasure_id: erasureId });
    expect(res.status).toBe(200);
    expect(await exists(m.userId)).toBe(false);
    expect(await exists(other.userId)).toBe(true);
    expect((await me(m.cookie)).status).toBe(401);
    expect((await me(second)).status).toBe(401);
    expect(await keyWorks(raw)).toBe(false);
    expect((await me(other.cookie)).status).toBe(200);

    await _settleAuditWrites();
    const audit = await sql<{ user_id: string | null; metadata: Record<string, unknown> }>`
      SELECT user_id, metadata FROM zv_audit_log
       WHERE event_type = 'user.deleted' AND resource_id = ${m.userId}`.execute(db);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.user_id).toBeNull();
    expect(audit.rows[0]!.metadata).toEqual({
      actor: 'self',
      reason: 'self.erasure',
      confirmed_by: 'password',
      erasure_id: erasureId,
    });
  });

  it('an erasure_id is an opaque uuid, nothing else', async () => {
    const m = await createMemberSession(app, db);
    const res = await erase(
      { cookie: m.cookie },
      { password: PASSWORD, erasure_id: 'x'.repeat(5000) },
    );
    expect(res.status).toBe(400);
    expect(await exists(m.userId)).toBe(true);
  });

  it('an account with a passkey steps up for account.delete; its password alone is refused', async () => {
    const m = await createMemberSession(app, db, { configWindow: true });
    const pw = await erase({ cookie: m.cookie }, { password: PASSWORD });
    expect(pw.status).toBe(403);
    expect(await codeOf(pw)).toBe('step_up_required');
    // A token for another action does not erase.
    const wrong = await erase({ cookie: m.cookie, ...(await m.stepUp!('config')) }, {});
    expect(wrong.status).toBe(403);
    expect(await exists(m.userId)).toBe(true);
    const ok = await erase({ cookie: m.cookie, ...(await m.stepUp!('account.delete')) });
    expect(ok.status).toBe(200);
    expect(await exists(m.userId)).toBe(false);
  });

  it('an account with no password needs a fresh OAuth sign-in', async () => {
    const m = await createMemberSession(app, db);
    await sql`UPDATE account SET password = NULL
               WHERE "providerId" = 'credential' AND "userId" = ${m.userId}`.execute(db);
    const stale = await erase({ cookie: m.cookie }, { password: PASSWORD });
    expect(stale.status).toBe(403);
    expect(await codeOf(stale)).toBe('recent_sign_in_required');
    expect(await exists(m.userId)).toBe(true);
    // What Better Auth's session hook notes when an OAuth callback creates the session.
    const signed = decodeURIComponent(/session_token=([^;]+)/.exec(m.cookie)![1]!);
    const token = signed.slice(0, signed.lastIndexOf('.'));
    await noteSessionOrigin(token, '/callback/:id');
    const ok = await erase({ cookie: m.cookie });
    expect(ok.status).toBe(200);
    expect(await exists(m.userId)).toBe(false);
  });
});
