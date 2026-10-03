/**
 * Migration 043 — an environment has no Postgres schema of its own.
 *
 * UP lets `zv_environments.schema_name` be NULL and must survive a second run.
 * DOWN puts NOT NULL back, so it first gives every NULL row '' — as the plain
 * owner role production migrates with, which FORCE RLS binds to one tenant per
 * write — and must leave a legacy schema name exactly as it was.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = `hes${Date.now().toString(36)}`;
const MIGRATION = new URL(
  '../../db/migrations/sql/043_environment_schema_optional.sql',
  import.meta.url,
);

async function run(trx: Database, part: 'up' | 'down'): Promise<void> {
  const parsed = parseMigrationFile(await Bun.file(MIGRATION).text());
  for (const stmt of splitSqlStatements(parsed[part] ?? '')) await sql.raw(stmt).execute(trx);
}

const notNull = async (trx: Database) =>
  (
    await sql<{ n: boolean }>`
      SELECT attnotnull AS n FROM pg_attribute
       WHERE attrelid = 'zv_environments'::regclass AND attname = 'schema_name'`.execute(trx)
  ).rows[0]?.n;

d('migration 043: environment schema_name is optional', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  it('UP twice, DOWN as a plain owner under FORCE RLS, UP again', async () => {
    // The harness connects as a superuser, which RLS never binds, so the owner
    // is swapped for a plain role inside a transaction that is rolled back.
    const rollback = new Error('rollback');
    const seen: Record<string, unknown> = {};
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await db
      .transaction()
      .execute(async (trx) => {
        for (const t of [a, b]) {
          await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${t}, ${`${STAMP}-${t.slice(0, 8)}`}, 'hes')`.execute(
            trx,
          );
        }
        await sql`ALTER TABLE zv_environments OWNER TO zveltio_rls`.execute(trx);
        await sql.raw('SET LOCAL ROLE zveltio_rls').execute(trx);
        await run(trx, 'up');
        await run(trx, 'up');
        seen.afterUp = await notNull(trx);

        await sql.raw('RESET ROLE').execute(trx);
        await sql`
          INSERT INTO zv_environments (tenant_id, name, slug, schema_name) VALUES
            (${a}, 'p', 'prod', NULL), (${b}, 'p', 'prod', NULL), (${b}, 'l', 'legacy', 'tenant_kept')
        `.execute(trx);
        await sql.raw('SET LOCAL ROLE zveltio_rls').execute(trx);

        await run(trx, 'down');
        seen.afterDown = await notNull(trx);
        await sql.raw('RESET ROLE').execute(trx);
        seen.rows = (
          await sql<{ k: string }>`
            SELECT (tenant_id = ${a})::text || ':' || slug || '=' || coalesce(schema_name, 'NULL') AS k
              FROM zv_environments WHERE tenant_id IN (${a}, ${b}) ORDER BY 1`.execute(trx)
        ).rows.map((r) => r.k);
        seen.gucs = (
          await sql<{ v: string }>`
            SELECT coalesce(current_setting('zveltio.current_tenant', true), '') || '|' ||
                   coalesce(current_setting('zveltio.visible_tenants', true), '') AS v`.execute(trx)
        ).rows[0]?.v;

        await sql.raw('SET LOCAL ROLE zveltio_rls').execute(trx);
        await run(trx, 'up');
        seen.afterReUp = await notNull(trx);
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });

    expect(seen).toEqual({
      afterUp: false,
      afterDown: true,
      // Both tenants' NULL rows got '', each written as its own tenant; the
      // legacy name is untouched.
      rows: ['false:legacy=tenant_kept', 'false:prod=', 'true:prod='],
      // The DOWN leaves no tenant reach behind in the migration's transaction.
      gucs: '|',
      afterReUp: false,
    });
  }, 60_000);
});
