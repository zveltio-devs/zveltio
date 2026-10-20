/**
 * A migration whose ledger row cannot be written is not applied.
 *
 * The two tracking inserts used to end `.catch(console.warn)` and ran after the
 * migration's transaction had committed. Measured with a trigger refusing the
 * `zv_schema_versions` row: the DDL stayed, nothing was recorded, and
 * `runPending` returned the file as applied — so the caller answered success and
 * the next boot ran the file again. The row is now written inside the
 * migration's own transaction (a refusal rolls the DDL back with it), and for a
 * `-- NO TRANSACTION` file, whose statements cannot be undone, the refusal is
 * thrown instead of printed.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, runPending, splitSqlStatements } from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const SQL_DIR = join(import.meta.dir, '../../db/migrations/sql');

/** The file as it was before it ran: its DOWN applied, its ledger row gone. */
async function unapply(db: Database, version: number, filename: string): Promise<void> {
  const { down } = parseMigrationFile(readFileSync(join(SQL_DIR, filename), 'utf8'));
  for (const stmt of splitSqlStatements(down as string)) {
    await sql.raw(stmt).execute(db);
  }
  await sql`DELETE FROM zv_schema_versions WHERE version = ${version}`.execute(db);
}

async function refuseLedgerRow(db: Database, version: number): Promise<void> {
  await sql
    .raw(`
    CREATE OR REPLACE FUNCTION zz_refuse_ledger() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'ledger refused'; END $$`)
    .execute(db);
  await sql
    .raw(`
    CREATE TRIGGER zz_refuse_ledger BEFORE INSERT OR UPDATE ON zv_schema_versions
      FOR EACH ROW WHEN (NEW.version = ${version}) EXECUTE FUNCTION zz_refuse_ledger()`)
    .execute(db);
}

async function allowLedgerRow(db: Database): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS zz_refuse_ledger ON zv_schema_versions`.execute(db);
  await sql`DROP FUNCTION IF EXISTS zz_refuse_ledger()`.execute(db);
}

const recorded = async (db: Database, version: number): Promise<number> =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_schema_versions
       WHERE version = ${version} AND rolled_back_at IS NULL`.execute(db)
  ).rows[0]?.n ?? 0;

d('migration tracking failure', () => {
  afterAll(async () => {
    const { db } = await getTestApp();
    await allowLedgerRow(db);
    await runPending(db);
  });

  it('rolls a transactional migration back and reports it not applied', async () => {
    const { db } = await getTestApp();
    const allowsCondition = async () =>
      (
        await sql<{ def: string }>`
          SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conname = 'zv_flow_steps_type_check'`.execute(db)
      ).rows[0]?.def.includes("'condition'") ?? false;

    await unapply(db, 88, '088_flow_condition_step.sql');
    expect(await allowsCondition()).toBe(false);
    await refuseLedgerRow(db, 88);
    try {
      await expect(runPending(db)).rejects.toThrow('ledger refused');
      expect(await recorded(db, 88)).toBe(0);
      // The DDL went with the row, so the next run applies the whole file.
      expect(await allowsCondition()).toBe(false);
    } finally {
      await allowLedgerRow(db);
    }
    expect(await runPending(db)).toEqual(['088_flow_condition_step.sql']);
    expect(await allowsCondition()).toBe(true);
    expect(await recorded(db, 88)).toBe(1);
  }, 60_000);

  it('fails a -- NO TRANSACTION migration instead of reporting it applied', async () => {
    const { db } = await getTestApp();
    await unapply(db, 67, '067_drop_redundant_indexes.sql');
    await refuseLedgerRow(db, 67);
    try {
      await expect(runPending(db)).rejects.toThrow('ledger refused');
      expect(await recorded(db, 67)).toBe(0);
    } finally {
      await allowLedgerRow(db);
    }
    expect(await runPending(db)).toEqual(['067_drop_redundant_indexes.sql']);
    expect(await recorded(db, 67)).toBe(1);
  }, 60_000);
});
