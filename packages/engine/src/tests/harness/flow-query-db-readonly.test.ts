/**
 * `query_db` is read-only because POSTGRES says so, not because a regex does.
 *
 * The step used to be guarded by a prefix check (`SELECT`/`WITH`) plus a
 * denylist whose every pattern required a leading `;`. A data-modifying CTE
 * satisfies both and writes anyway:
 *
 *   WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x
 *
 * It starts with WITH, contains no `;`, and deletes the table. The fix is
 * `SET TRANSACTION READ ONLY` in the same transaction as the query, which the
 * database enforces regardless of how the statement is shaped.
 *
 * These run against a real database on purpose. The claim is about what
 * Postgres does, so asserting it against a mock would only test the mock — and
 * the ordering constraint (SET TRANSACTION must precede any statement, while
 * the tenant GUC must still apply) is exactly the kind of thing that silently
 * regresses.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/** Exactly what the executor now does around a user query. */
async function runAsQueryDbStep(db: Database, query: string, tenantId = 'harness-tenant') {
  return db.transaction().execute(async (trx) => {
    await sql.raw('SET TRANSACTION READ ONLY').execute(trx);
    await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
    await sql.raw(`SET LOCAL statement_timeout = '10s'`).execute(trx);
    return sql.raw(query).execute(trx);
  });
}

d('query_db read-only enforcement', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql.raw('DROP TABLE IF EXISTS zv_ro_probe').execute(db);
    await sql.raw('CREATE TABLE zv_ro_probe (id int)').execute(db);
    await sql.raw('INSERT INTO zv_ro_probe VALUES (1), (2), (3)').execute(db);
  });

  it('refuses a DELETE hidden in a CTE', async () => {
    await expect(
      runAsQueryDbStep(db, 'WITH x AS (DELETE FROM zv_ro_probe RETURNING *) SELECT * FROM x'),
    ).rejects.toThrow(/read-only/i);

    const after = await sql<{ n: string }>`SELECT count(*) AS n FROM zv_ro_probe`.execute(db);
    expect(Number(after.rows[0]!.n)).toBe(3);
  });

  it('refuses an UPDATE and an INSERT hidden in a CTE', async () => {
    for (const q of [
      'WITH x AS (UPDATE zv_ro_probe SET id = 99 RETURNING *) SELECT * FROM x',
      'WITH x AS (INSERT INTO zv_ro_probe VALUES (4) RETURNING *) SELECT * FROM x',
    ]) {
      await expect(runAsQueryDbStep(db, q)).rejects.toThrow(/read-only/i);
    }
    const rows = await sql<{ id: number }>`SELECT id FROM zv_ro_probe ORDER BY id`.execute(db);
    expect(rows.rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('refuses DDL', async () => {
    await expect(
      runAsQueryDbStep(db, 'CREATE TABLE zv_ro_should_not_exist (id int)'),
    ).rejects.toThrow();
    const t = await sql<{ n: string }>`
      SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'zv_ro_should_not_exist'
    `.execute(db);
    expect(Number(t.rows[0]!.n)).toBe(0);
  });

  it('still runs an ordinary SELECT', async () => {
    const res = await runAsQueryDbStep(db, 'SELECT id FROM zv_ro_probe ORDER BY id');
    expect((res as { rows: { id: number }[] }).rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('still applies the tenant GUC, so RLS is unaffected', async () => {
    // The regression risk of this fix: SET TRANSACTION READ ONLY has to come
    // FIRST, and setting a GUC after it must still work — otherwise the step
    // would run read-only but tenant-blind, which is worse than the bug.
    const res = await runAsQueryDbStep(
      db,
      `SELECT current_setting('zveltio.current_tenant', true) AS t`,
      'tenant-xyz',
    );
    expect((res as { rows: { t: string }[] }).rows[0]!.t).toBe('tenant-xyz');
  });

  it('still runs a legitimate read-only CTE', async () => {
    const res = await runAsQueryDbStep(
      db,
      'WITH x AS (SELECT id FROM zv_ro_probe WHERE id > 1) SELECT count(*) AS n FROM x',
    );
    expect(Number((res as { rows: { n: string }[] }).rows[0]!.n)).toBe(2);
  });
});
