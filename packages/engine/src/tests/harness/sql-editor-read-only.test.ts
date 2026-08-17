/**
 * SEC-03 — `POST /api/admin/sql` is read-only unless the caller asks otherwise.
 *
 * The route used to run whatever it was handed; the comment in it said READ
 * ONLY was "intentionally NOT set" so DDL would work. An instance admin is
 * powerful by definition, but "I opened the query screen to look at something"
 * and "I changed the data" should not be the same action, and afterwards should
 * not be the same audit record.
 *
 * Run against a real Postgres on purpose. The refusal is the database's, from
 * `SET TRANSACTION READ ONLY` — no check that reads the SQL text survives
 * casing, comments, or `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`,
 * and whatever slips past such a check runs with full rights. Asserting against
 * a mock would test that the engine sends a string, not that writes are
 * actually refused.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TABLE = `zz_sqled_${Date.now()}`;

d('sql editor read-only default (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  async function runSql(body: Record<string, unknown>) {
    const res = await app.request('/api/admin/sql', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    db = ctx.db;
    cookie = await createGodSession(app, db);
    // A table of our own to write to, so the write-mode case does not depend on
    // any other table's contents. Created directly rather than through the
    // route under test — the route is what is being measured.
    await sql.raw(`CREATE TABLE IF NOT EXISTS ${TABLE} (id int)`).execute(db);
  });

  it('runs a SELECT without being asked for anything', async () => {
    const { status, body } = await runSql({ query: 'SELECT 1 AS ok' });
    expect(status).toBe(200);
    expect(body.rowCount).toBe(1);
  });

  it('refuses a write when no mode is given', async () => {
    const { status, body } = await runSql({ query: `INSERT INTO ${TABLE} (id) VALUES (1)` });
    expect(status).toBe(400);
    // Postgres' own words. Asserted because a write refused for some unrelated
    // reason — a missing privilege, a bad table name — would pass a bare status
    // check while READ ONLY was never applied at all.
    expect(String(body.detail ?? body.error)).toMatch(/read-only transaction/i);
  });

  it('refuses DDL when no mode is given', async () => {
    const { status, body } = await runSql({ query: `DROP TABLE ${TABLE}` });
    expect(status).toBe(400);
    expect(String(body.detail ?? body.error)).toMatch(/read-only transaction/i);
  });

  // A blocklist on the query text is defeated by this exact shape: the
  // statement begins with WITH and ends in SELECT, and deletes rows in between.
  it('refuses a write hidden inside a CTE', async () => {
    const { status, body } = await runSql({
      query: `WITH gone AS (DELETE FROM ${TABLE} RETURNING id) SELECT count(*) FROM gone`,
    });
    expect(status).toBe(400);
    expect(String(body.detail ?? body.error)).toMatch(/read-only transaction/i);
  });

  it('performs the same write when the caller asks for write mode', async () => {
    const { status } = await runSql({
      query: `INSERT INTO ${TABLE} (id) VALUES (1)`,
      mode: 'write',
    });
    expect(status).toBe(200);

    const check = await runSql({ query: `SELECT count(*)::int AS n FROM ${TABLE}` });
    expect((check.body.rows as Array<{ n: number }>)[0]!.n).toBe(1);
  });

  it('records a write as its own audit event', async () => {
    const rows = await db
      .selectFrom('zv_audit_log')
      .select(['event_type'])
      .where('event_type', 'in', ['sql.executed', 'sql.write.executed'])
      .execute();
    const types = rows.map((r) => r.event_type);
    expect(types).toContain('sql.write.executed');
    expect(types).toContain('sql.executed');
  });

  it('cleans up after itself', async () => {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
  });
});
