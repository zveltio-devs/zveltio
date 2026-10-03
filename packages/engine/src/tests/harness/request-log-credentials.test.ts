/**
 * The request log holds no invitation token.
 *
 * It recorded `c.req.path`, and `GET /api/invitations/:token` carries a live
 * invitation: one SELECT on `zv_request_logs` was every invitation that had been
 * opened, after 038 removed them from `zv_invitations`. The writer now records
 * the route's parameter name; migration 050 rewrites the rows written before.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const MIGRATION = new URL(
  '../../db/migrations/sql/050_scrub_logged_credentials.sql',
  import.meta.url,
);

d('invitation tokens in the request and slow-request logs', () => {
  it('opening an invitation logs the route, not the token', async () => {
    const { app, db } = await getTestApp();
    const cookie = await createGodSession(app, db);
    const email = `reqlog-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
    const invited = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ email, role: 'member' }),
    });
    expect(invited.status).toBe(201);
    const { invite_url } = (await invited.json()) as { invite_url: string };
    const token = new URL(invite_url).searchParams.get('token') ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const since = new Date();
    expect((await app.request(`/api/invitations/${token}`)).status).toBe(200);

    // The write is deferred until the request settles: wait for the row, so a
    // log that stopped writing cannot pass for one that redacts.
    let logged = 0;
    for (let i = 0; i < 100 && !logged; i++) {
      logged = (
        await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM zv_request_logs
           WHERE path = '/api/invitations/:token' AND created_at >= ${since}`.execute(db)
      ).rows[0]!.n;
      if (!logged) await Bun.sleep(50);
    }
    expect(logged).toBe(1);
    const leaked = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_request_logs WHERE path LIKE ${`%${token}%`}`.execute(db);
    expect(leaked.rows[0]!.n).toBe(0);
  }, 60_000);

  it('migration 050 rewrites rows written before, and runs twice', async () => {
    const { db } = await getTestApp();
    const tok = crypto.randomUUID().replace(/-/g, '');
    const rollback = new Error('rollback');
    const seen: Record<string, unknown> = {};
    await db
      .transaction()
      .execute(async (trx) => {
        await sql`
          INSERT INTO zv_request_logs (method, path, status, duration_ms) VALUES
            ('GET', ${`/api/invitations/${tok}`}, 200, 1),
            ('POST', '/api/invitations/accept', 200, 1)`.execute(trx);
        await sql`
          INSERT INTO zv_slow_queries (method, path, query_params, duration_ms) VALUES
            ('GET', ${`/api/invitations/${tok}`}, '{}'::jsonb, 300),
            ('GET', ${`/api/auth/reset-password/${tok}`}, ${JSON.stringify({ callbackURL: '/x' })}::text::jsonb, 300),
            ('GET', '/api/auth/verify-email', ${JSON.stringify({ token: tok, page: '2' })}::text::jsonb, 300)
        `.execute(trx);
        const { up } = parseMigrationFile(await Bun.file(MIGRATION).text());
        for (let run = 0; run < 2; run++) {
          for (const stmt of splitSqlStatements(up)) await sql.raw(stmt).execute(trx);
        }
        seen.leaked = (
          await sql<{ n: number }>`
            SELECT (SELECT count(*) FROM zv_request_logs WHERE path LIKE ${`%${tok}%`})
                 + (SELECT count(*) FROM zv_slow_queries
                     WHERE path LIKE ${`%${tok}%`} OR query_params::text LIKE ${`%${tok}%`}) AS n
          `.execute(trx)
        ).rows[0]!.n;
        seen.accept = (
          await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM zv_request_logs
             WHERE path = '/api/invitations/accept'`.execute(trx)
        ).rows[0]!.n;
        seen.verify = (
          await sql<{ q: unknown }>`
            SELECT query_params AS q FROM zv_slow_queries
             WHERE path = '/api/auth/verify-email' AND query_params->>'page' = '2'
             ORDER BY created_at DESC LIMIT 1`.execute(trx)
        ).rows[0]!.q;
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });

    expect(Number(seen.leaked)).toBe(0);
    expect(Number(seen.accept)).toBeGreaterThanOrEqual(1);
    expect(seen.verify).toEqual({ token: '[redacted]', page: '2' });
  }, 60_000);
});
