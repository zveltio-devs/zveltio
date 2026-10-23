/**
 * A deleted validation rule leaves the groups that named it (migration 096).
 *
 * Measured on master: `zvd_validation_rule_groups.rule_ids` is a uuid[] with no
 * key behind it, and every path that deletes a rule (ctx.internals
 * writeValidationRule, schema apply, a field removed, a tenant's cascade) left
 * the id in place. The evaluator skips ids it cannot find, but the extension
 * lists groups with SELECT *, so the dead ids reached the UI forever.
 *
 * Now an AFTER DELETE trigger on `zv_validation_rules` removes the id from every
 * group, and 096 removes the ids already dead. A group left with no members is
 * kept: an empty group is one the API lets an admin create, and it combines
 * nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import { asEngineRole } from '../../lib/role-window.js';
import { DEFAULT_TENANT_ID, withTenantIsolation } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `vrgm_${Date.now()}`;
const migration = (file: string) =>
  new URL(`../../db/migrations/sql/${file}.sql`, import.meta.url).pathname;
const M096 = migration('096_validation_rule_group_members');
// 097 renames 096's trigger, so 096 is rolled back and re-applied under it.
const M097 = migration('097_validation_test_case_orphans');

d('validation rule group members', () => {
  let db: Database;
  let createdTable = false;

  // A config each: an instance rule's key is unique (migration 098).
  let n = 0;
  const rule = async () =>
    (
      await db
        .insertInto('zv_validation_rules')
        .values({
          collection: C,
          field_name: 'tax_id',
          rule_type: 'required',
          rule_config: toJsonb({ n: ++n }),
          error_message: 'x',
          is_active: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const group = async (name: string, ids: string[]) => {
    await sql`INSERT INTO zvd_validation_rule_groups
                (name, collection, field_name, logic, rule_ids, created_by)
              VALUES (${name}, ${C}, 'tax_id', 'OR', ${ids}::uuid[], 'test')`.execute(db);
  };
  // A uuid[] arrives as its text form, so it is read joined.
  const members = async (name: string) => {
    const r = await sql<{ ids: string }>`
      SELECT array_to_string(rule_ids, ',') AS ids FROM zvd_validation_rule_groups
       WHERE collection = ${C} AND name = ${name}`.execute(db);
    const ids = r.rows[0]?.ids;
    return ids === undefined ? undefined : ids === '' ? [] : ids.split(',');
  };
  const runMigration = async (file: string, half: 'up' | 'down') => {
    const parsed = parseMigrationFile(await Bun.file(file).text());
    await db.transaction().execute(async (trx) => {
      for (const stmt of splitSqlStatements(parsed[half] ?? '')) await sql.raw(stmt).execute(trx);
    });
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    createdTable = !(
      await sql<{ ok: boolean }>`
        SELECT to_regclass('zvd_validation_rule_groups') IS NOT NULL AS ok`.execute(db)
    ).rows[0]!.ok;
    // developer/validation's table, in its shape after 091.
    await sql`CREATE TABLE IF NOT EXISTS zvd_validation_rule_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
      collection TEXT NOT NULL, field_name TEXT NOT NULL, description TEXT,
      logic TEXT NOT NULL DEFAULT 'AND' CHECK (logic IN ('AND','OR')),
      rule_ids UUID[] NOT NULL DEFAULT '{}', is_active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.execute(db);
  }, 120_000);

  afterAll(async () => {
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${C}`.execute(db);
    if (createdTable) await sql`DROP TABLE IF EXISTS zvd_validation_rule_groups`.execute(db);
    else await sql`DELETE FROM zvd_validation_rule_groups WHERE collection = ${C}`.execute(db);
  });

  it('a deleted rule leaves every group that named it, and an emptied group stays', async () => {
    const [a, b] = [await rule(), await rule()];
    await group('either', [a, b]);
    await group('only_b', [b]);
    await db.deleteFrom('zv_validation_rules').where('id', '=', b).execute();
    expect(await members('either')).toEqual([a]);
    expect(await members('only_b')).toEqual([]);
  });

  // ctx.internals.writeValidationRule's shape: a request transaction under the
  // request role, the delete in the engine's role window.
  it('a delete from inside a tenant request, as the engine, clears the member', async () => {
    const [a, b] = [await rule(), await rule()];
    await group('request', [a, b]);
    await withTenantIsolation(DEFAULT_TENANT_ID, (trx) =>
      asEngineRole(trx, () => trx.deleteFrom('zv_validation_rules').where('id', '=', a).execute()),
    );
    expect(await members('request')).toEqual([b]);
  });

  it('a bulk delete (a field or collection removed) clears every member', async () => {
    const [a, b] = [await rule(), await rule()];
    await group('bulk', [a, b]);
    await db.deleteFrom('zv_validation_rules').where('id', 'in', [a, b]).execute();
    expect(await members('bulk')).toEqual([]);
  });

  it('096 removes the ids already dead, and its DOWN takes the trigger away', async () => {
    const a = await rule();
    const dead = crypto.randomUUID();
    await group('planted', [dead, a]);
    await runMigration(M097, 'down');
    await runMigration(M096, 'up');
    expect(await members('planted')).toEqual([a]);

    await runMigration(M096, 'down');
    const b = await rule();
    await group('after_down', [b]);
    await db.deleteFrom('zv_validation_rules').where('id', '=', b).execute();
    expect(await members('after_down')).toEqual([b]);
    await runMigration(M096, 'up');
    await runMigration(M097, 'up');
    expect(await members('after_down')).toEqual([]);
  });

  it('a rule still deletes when the extension table is absent', async () => {
    if (!createdTable) return; // the extension is really installed here
    await sql`DROP TABLE zvd_validation_rule_groups`.execute(db);
    const a = await rule();
    await db.deleteFrom('zv_validation_rules').where('id', '=', a).execute();
    const left = await db
      .selectFrom('zv_validation_rules')
      .select('id')
      .where('id', '=', a)
      .execute();
    expect(left).toEqual([]);
  });
});
