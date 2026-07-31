/**
 * `query_db` cannot read the auth tables — enforced by Postgres, not by a gate.
 *
 * A tenant admin could author a flow step running `SELECT token FROM "session"`
 * and collect every live session on the instance, god sessions included. Neither
 * of the existing protections touched it: `SET TRANSACTION READ ONLY` stops
 * writes and the attack is a read, and the tenant GUC only governs `zvd_*` rows.
 *
 * Authorship is now gated to instance admins, which contains the escalation.
 * This is the boundary: the step runs as a role holding SELECT on collection
 * tables and nothing else, so the read is refused regardless of who wrote the
 * query or how it is shaped.
 *
 * Against a real database on purpose — the claim is entirely about what
 * Postgres permits.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/** Exactly what the executor does around a user-authored query. */
async function runAsQueryDbStep(db: Database, query: string, tenantId = 'harness-tenant') {
  return db.transaction().execute(async (trx) => {
    await sql.raw('SET TRANSACTION READ ONLY').execute(trx);
    await sql.raw('SET LOCAL ROLE zveltio_flow_reader').execute(trx);
    await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
    await sql.raw(`SET LOCAL statement_timeout = '10s'`).execute(trx);
    return sql.raw(query).execute(trx);
  });
}

d('query_db cannot reach the auth tables', () => {
  let db: Database;
  let roleExists = false;
  let collectionTable = '';

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const r = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_flow_reader') AS ok
    `.execute(db);
    roleExists = r.rows[0]?.ok === true;
    const t = await sql<{ tablename: string }>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'zvd\\_%' LIMIT 1
    `.execute(db);
    collectionTable = t.rows[0]?.tablename ?? '';
  });

  it('created the role (migration 024 applied)', () => {
    // If this fails on a managed Postgres that cannot CREATE ROLE, the
    // executor degrades to the authorship gate — deliberately, see the
    // migration. Here the harness owns its database, so it must exist.
    expect(roleExists).toBe(true);
  });

  it('refuses to read the session table', async () => {
    await expect(runAsQueryDbStep(db, 'SELECT token FROM "session"')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('refuses the user and account tables too', async () => {
    // A session token is the sharpest tool, but a password hash or an OAuth
    // refresh token is the same class of loss.
    for (const q of ['SELECT * FROM "user"', 'SELECT * FROM "account"']) {
      await expect(runAsQueryDbStep(db, q)).rejects.toThrow(/permission denied/i);
    }
  });

  it('refuses system tables the tenant GUC never covered', async () => {
    for (const q of [
      'SELECT * FROM zv_extension_registry',
      'SELECT * FROM zv_audit_log',
      'SELECT * FROM zv_settings',
    ]) {
      await expect(runAsQueryDbStep(db, q)).rejects.toThrow(/permission denied/i);
    }
  });

  it('is not defeated by a schema-qualified name', async () => {
    // The guard is a grant, not a string match, so qualifying the table does
    // not help — which is the entire reason for moving it into the database.
    await expect(runAsQueryDbStep(db, 'SELECT token FROM public."session"')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('is not defeated by hiding the read in a CTE', async () => {
    await expect(
      runAsQueryDbStep(db, 'WITH s AS (SELECT token FROM "session") SELECT * FROM s'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('still reads collection data, which is the point of the step', async () => {
    if (!collectionTable) return; // no zvd_* table in this database yet
    const res = await runAsQueryDbStep(db, `SELECT count(*) AS n FROM "${collectionTable}"`);
    expect(Number((res as { rows: { n: string }[] }).rows[0]!.n)).toBeGreaterThanOrEqual(0);
  });

  it('still refuses writes — the read-only guarantee is unchanged', async () => {
    if (!collectionTable) return;
    await expect(
      runAsQueryDbStep(
        db,
        `WITH x AS (DELETE FROM "${collectionTable}" RETURNING *) SELECT * FROM x`,
      ),
    ).rejects.toThrow();
  });
});
