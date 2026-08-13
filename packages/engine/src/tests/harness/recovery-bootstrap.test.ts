/**
 * SEC-07 — `POST /api/permissions/bootstrap` promotes a user to god without a
 * session, on a bearer token alone.
 *
 * It is a legitimate endpoint: it is what an operator has left when every admin
 * account is locked out. What it lacked was every property that makes such an
 * endpoint survivable — the grant was not recorded anywhere, the token could be
 * replayed forever, guesses were unlimited, and the comparison returned early
 * on the first differing byte.
 *
 * Against a real Postgres because "used once" has to mean the fact survives
 * somewhere durable. A mock would prove the code writes a row, not that the
 * second attempt reads it back.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TOKEN = `recovery-test-${'x'.repeat(40)}`;
const EMAIL = `recovery-${Date.now()}@test.local`;

d('recovery bootstrap (in-process)', () => {
  let app: Hono;
  let db: Database;
  let userId: string;
  let savedToken: string | undefined;

  async function bootstrap(token: string | null, email = EMAIL) {
    const res = await app.request('/api/permissions/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ email }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    db = ctx.db;
    savedToken = process.env.RECOVERY_TOKEN;
    process.env.RECOVERY_TOKEN = TOKEN;

    userId = crypto.randomUUID();
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${userId}, 'Recovery Target', ${EMAIL}, false, 'member', now(), now())
    `.execute(db);
    // A previous run may have spent a token; this suite brings its own.
    await sql`DELETE FROM zv_settings WHERE key = 'security.recovery_token_used'`.execute(db);
  });

  afterAll(async () => {
    if (savedToken === undefined) delete process.env.RECOVERY_TOKEN;
    else process.env.RECOVERY_TOKEN = savedToken;
    await sql`DELETE FROM "user" WHERE id = ${userId}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_settings WHERE key = 'security.recovery_token_used'`
      .execute(db)
      .catch(() => {});
  });

  it('refuses a wrong token', async () => {
    const { status } = await bootstrap(`wrong-${'y'.repeat(40)}`);
    expect(status).toBe(401);
  });

  it('records the refusal, because a failed attempt here IS the attack', async () => {
    const rows = await db
      .selectFrom('zv_audit_log')
      .select(['event_type', 'metadata'])
      .where('resource_type', '=', 'recovery_bootstrap')
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.some((r) => (r.metadata as { outcome?: string } | null)?.outcome === 'refused'),
    ).toBe(true);
  });

  it('grants god on the real token', async () => {
    const { status, body } = await bootstrap(TOKEN);
    expect(status).toBe(200);
    expect((body.user as { role: string }).role).toBe('god');
  });

  it('records the grant — the most privileged action wrote nothing at all before', async () => {
    const rows = await db
      .selectFrom('zv_audit_log')
      .select(['metadata'])
      .where('resource_type', '=', 'recovery_bootstrap')
      .execute();
    expect(
      rows.some((r) => (r.metadata as { outcome?: string } | null)?.outcome === 'granted'),
    ).toBe(true);
  });

  it('refuses the same token a second time', async () => {
    const { status, body } = await bootstrap(TOKEN);
    expect(status).toBe(409);
    // The message has to say what to do next. "Forbidden" would send an
    // operator who is already locked out looking for a bug.
    // The engine rewrites error bodies to RFC 7807, so the message arrives as
    // `detail`; accept either so the assertion survives that layer changing.
    expect(String(body.detail ?? body.error)).toMatch(/rotate RECOVERY_TOKEN/i);
  });

  it('accepts a rotated token', async () => {
    const rotated = `rotated-${'z'.repeat(40)}`;
    process.env.RECOVERY_TOKEN = rotated;
    const { status } = await bootstrap(rotated);
    expect(status).toBe(200);
    process.env.RECOVERY_TOKEN = TOKEN;
  });
});
