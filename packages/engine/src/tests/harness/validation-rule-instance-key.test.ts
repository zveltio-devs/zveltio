/**
 * Migration 098: one instance validation rule per (collection, field, rule type,
 * config), the key the schema artifact names it by. Writer refusal:
 * validation-rules-instance-admin.test.ts; schema apply:
 * schema-validation-groups.test.ts. Here: what 098 does to the duplicates an
 * instance already has — one survives (active first, then oldest), the groups
 * and test cases naming the rest name it instead, in every tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  asEveryTenant,
  asTenant,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `vrik_${STAMP}`;
const A = { id: crypto.randomUUID(), slug: `vrik-a-${STAMP}` };
const G = 'zvd_validation_rule_groups';
const T = 'zvd_validation_test_cases';
const M098 = new URL(
  '../../db/migrations/sql/098_validation_rule_instance_key.sql',
  import.meta.url,
).pathname;

d('migration 098: one instance validation rule per key', () => {
  let db: Database;
  const created: string[] = [];

  const exists = async (t: string) =>
    (await sql<{ ok: boolean }>`SELECT to_regclass(${t}) IS NOT NULL AS ok`.execute(db)).rows[0]!
      .ok;
  const rule = async (is_active: boolean, at: string, tenant_id: string | null = null) =>
    (
      await db
        .insertInto('zv_validation_rules')
        .values({
          collection: C,
          field_name: 'code',
          rule_type: 'pattern',
          rule_config: toJsonb({ pattern: '^A' }),
          error_message: 'x',
          is_active,
          tenant_id,
          created_at: new Date(at),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const runMigration = async (half: 'up' | 'down') => {
    const parsed = parseMigrationFile(await Bun.file(M098).text());
    await db.transaction().execute(async (trx) => {
      for (const stmt of splitSqlStatements(parsed[half] ?? '')) await sql.raw(stmt).execute(trx);
    });
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${A.id}::uuid, ${A.slug}, 'vrik', 'active')`.execute(db);
    // developer/validation's tables, in the shape its 001-004 leave them.
    if (!(await exists(G))) {
      created.push(G);
      await sql
        .raw(`CREATE TABLE ${G} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
        collection TEXT NOT NULL, field_name TEXT NOT NULL, description TEXT,
        logic TEXT NOT NULL DEFAULT 'AND', rule_ids UUID[] NOT NULL DEFAULT '{}',
        is_active BOOLEAN NOT NULL DEFAULT true, created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
        .execute(db);
    }
    if (!(await exists(T))) {
      created.push(T);
      await sql
        .raw(`CREATE TABLE ${T} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), rule_id UUID NOT NULL,
        label TEXT NOT NULL, input_value TEXT NOT NULL, previous_value TEXT,
        expected_result BOOLEAN NOT NULL, last_run_result BOOLEAN, last_run_at TIMESTAMPTZ,
        created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tenant_id UUID DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid,
                                        '00000000-0000-0000-0000-000000000001'::uuid));
        ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${T} FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation_${T} ON ${T}
          USING (zveltio_tenant_scope_ok(tenant_id)) WITH CHECK (zveltio_tenant_scope_ok(tenant_id));`)
        .execute(db);
    }
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await runMigration('up').catch(() => {});
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${C}`.execute(db);
    for (const t of created) await sql.raw(`DROP TABLE IF EXISTS ${t}`).execute(db);
    if (!created.includes(G))
      await sql`DELETE FROM ${sql.table(G)} WHERE collection = ${C}`.execute(db);
    if (!created.includes(T)) {
      await asEveryTenant(db, (trx) =>
        sql`DELETE FROM ${sql.table(T)} WHERE label = 'vrik'`.execute(trx),
      );
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${A.id}::uuid`.execute(db);
  });

  it('keeps the active rule of a key, and moves its group members and test cases to it', async () => {
    // As an instance from before 098 holds them.
    await runMigration('down');
    const oldInactive = await rule(false, '2026-01-01');
    const active = await rule(true, '2026-02-01');
    const newer = await rule(true, '2026-03-01');
    const tenants = await rule(true, '2026-01-01', A.id);
    await sql`INSERT INTO ${sql.table(G)} (name, collection, field_name, logic, rule_ids, created_by)
              VALUES ('either', ${C}, 'code', 'OR',
                      ${[newer, oldInactive, active]}::uuid[], 'test')`.execute(db);
    await asTenant(db, A.id, (trx) =>
      sql`INSERT INTO ${sql.table(T)} (rule_id, label, input_value, expected_result, created_by)
          VALUES (${newer}::uuid, 'vrik', 'v', true, 'test')`.execute(trx),
    );

    await runMigration('up');

    const left = await sql<{ id: string }>`
      SELECT id FROM zv_validation_rules WHERE collection = ${C} ORDER BY created_at, id`.execute(
      db,
    );
    expect(left.rows.map((r) => r.id).sort()).toEqual([active, tenants].sort());
    const g = await sql<{ ids: string }>`
      SELECT array_to_string(rule_ids, ',') AS ids FROM ${sql.table(G)}
       WHERE collection = ${C}`.execute(db);
    expect(g.rows[0]!.ids).toBe(active);
    const cases = await asEveryTenant(db, (trx) =>
      sql<{ rule_id: string }>`
        SELECT rule_id::text FROM ${sql.table(T)} WHERE label = 'vrik'`.execute(trx),
    );
    expect(cases.rows.map((r) => r.rule_id)).toEqual([active]);

    // The key holds from now on; a tenant's rule with it is not an instance rule.
    let errno: string | undefined;
    try {
      await rule(true, '2026-04-01');
    } catch (err) {
      errno = (err as { errno?: string }).errno;
    }
    expect(errno).toBe('23505');
    await rule(true, '2026-04-01', A.id);
  });
});
