/**
 * A failed RPC call must not hand the database's own words to the caller.
 *
 * `POST /api/rpc/:fn` runs operator-authored SQL and used to return
 * `err.message` verbatim with a 500. Measured before the fix, from a function
 * that violated a unique constraint:
 *
 *   duplicate key value violates unique constraint "zvd_rpc_secretish_email_key"
 *
 * That is the table, the constraint and therefore the column, handed to whoever
 * may call the function — and `required_role` on the whitelist can be `member`,
 * so that is not necessarily an administrator.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('RPC failures do not disclose the database (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const TABLE = `zvd_rpc_probe_${crypto.randomUUID().slice(0, 8)}`;
  const FN = `zv_rpc_probe_${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await sql`CREATE TABLE IF NOT EXISTS ${sql.raw(`"${TABLE}"`)} (id int primary key, email text unique)`.execute(
      db,
    );
    await sql`INSERT INTO ${sql.raw(`"${TABLE}"`)} (id, email) VALUES (1, 'alice@example.com')`.execute(
      db,
    );
    await sql`
      CREATE OR REPLACE FUNCTION ${sql.raw(`"${FN}"`)}() RETURNS TABLE(ok boolean) AS $fn$
      BEGIN
        INSERT INTO ${sql.raw(`"${TABLE}"`)} (id, email) VALUES (2, 'alice@example.com');
        RETURN QUERY SELECT true;
      END $fn$ LANGUAGE plpgsql;
    `.execute(db);
    await sql`
      INSERT INTO zvd_rpc_functions (function_name, description, required_role, is_enabled)
      VALUES (${FN}, 'disclosure probe', 'member', true)
    `.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`.execute(db);
    await sql`DROP FUNCTION IF EXISTS ${sql.raw(`"${FN}"`)}()`.execute(db);
    await sql`DROP TABLE IF EXISTS ${sql.raw(`"${TABLE}"`)}`.execute(db);
  });

  it('answers generically, naming no table, column or constraint', async () => {
    const res = await app.request(`/api/rpc/${FN}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(500);
    const body = await res.text();

    // The three things the raw message would have carried.
    expect(body).not.toContain(TABLE);
    expect(body).not.toContain('unique constraint');
    expect(body).not.toContain('email');
    // And it still says something, with a trace id an operator can match.
    expect(body).toContain('Function execution failed');
    expect(body).toContain('traceId');
  });

  it('still runs a function that works', async () => {
    // The obvious mistake in the other direction: swallowing the failure path
    // so thoroughly that the endpoint stops working.
    const ok = `zv_rpc_ok_${crypto.randomUUID().slice(0, 8)}`;
    await sql`CREATE OR REPLACE FUNCTION ${sql.raw(`"${ok}"`)}() RETURNS TABLE(n int) AS $fn$ BEGIN RETURN QUERY SELECT 42; END $fn$ LANGUAGE plpgsql`.execute(
      db,
    );
    await sql`INSERT INTO zvd_rpc_functions (function_name, required_role, is_enabled) VALUES (${ok}, 'member', true)`.execute(
      db,
    );
    try {
      const res = await app.request(`/api/rpc/${ok}`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('42');
    } finally {
      await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${ok}`.execute(db);
      await sql`DROP FUNCTION IF EXISTS ${sql.raw(`"${ok}"`)}()`.execute(db);
    }
  });
});
