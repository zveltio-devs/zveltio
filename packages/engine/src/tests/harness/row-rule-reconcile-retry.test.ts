/**
 * A table the boot reconcile cannot rebuild is retried (ADR 0037).
 *
 * `reconcileRowRulePolicies` rebuilt each table once and went on past a failure
 * (a table busy past the lock bound). That table kept the policy it had — on an
 * upgrade, the FOR ALL `zv_row_rules` whose exemption writes — and nothing
 * rebuilt it until a rule changed. It is retried now until it applies, and
 * `/health` (`db_rules`) names it meanwhile.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { reconcileFailures, reconcileRowRulePolicies } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLL = `rrretry_${Date.now()}`;
const TABLE = `zvd_${COLL}`;

async function until(check: () => Promise<boolean> | boolean, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return false;
}

d('row-rule reconcile retries a table it could not rebuild', () => {
  let db: Database;
  const policies = async () =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_policies
         WHERE tablename = ${TABLE} AND starts_with(policyname, 'zv_row_rules')`.execute(db)
    ).rows[0]!.n;
  const failing = () => reconcileFailures('row_rules').some((f) => f.table === COLL);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql
      .raw(`CREATE TABLE ${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by text)`)
      .execute(db);
    await sql`INSERT INTO zvd_collections (name, display_name) VALUES (${COLL}, ${COLL})`.execute(
      db,
    );
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLL}, '*', 'created_by', 'eq', 'user_id', true)`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLL}`.execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${COLL}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
  });

  it('records the failure, then applies the policies once the table is free', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db.transaction().execute(async (trx) => {
      await sql.raw(`LOCK TABLE ${TABLE} IN ACCESS SHARE MODE`).execute(trx);
      locked();
      await held;
    });
    await isLocked;

    await reconcileRowRulePolicies(db, 50);
    expect(failing()).toBe(true);
    expect(await policies()).toBe(0);

    release();
    await holder;
    expect(await until(async () => (await policies()) === 4 && !failing())).toBe(true);
  }, 60_000);
});
