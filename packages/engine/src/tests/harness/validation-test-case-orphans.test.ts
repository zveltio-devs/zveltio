/**
 * A deleted validation rule takes its test cases with it, in every tenant
 * (migration 097).
 *
 * Measured on master: `zvd_validation_test_cases.rule_id` has no key behind it,
 * and no path that deletes a rule touched the test cases, so they outlived it.
 * The table is tenant-scoped under FORCE RLS while a test case of an instance
 * rule may be any tenant's, and the engine deletes the rule inside the request's
 * tenant: a plain DELETE in the trigger would remove that tenant's and skip the
 * rest. The cross-tenant case only bites where RLS binds the engine, the
 * non-superuser owner lane (scripts/bootstrap-db-role.sh).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import { asEngineRole } from '../../lib/role-window.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  asTenant,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `vtco_${STAMP}`;
const A = { id: crypto.randomUUID(), slug: `vtco-a-${STAMP}` };
const B = { id: crypto.randomUUID(), slug: `vtco-b-${STAMP}` };
const T = 'zvd_validation_test_cases';
const M097 = new URL(
  '../../db/migrations/sql/097_validation_test_case_orphans.sql',
  import.meta.url,
).pathname;

d('validation test cases follow their rule', () => {
  let db: Database;
  let createdTable = false;

  const rule = async () =>
    (
      await db
        .insertInto('zv_validation_rules')
        .values({
          collection: C,
          field_name: 'code',
          rule_type: 'required',
          rule_config: toJsonb({}),
          error_message: 'x',
          is_active: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  // Written as the extension writes it: inside the tenant, tenant_id by default.
  const testCase = (tenant: string, ruleId: string) =>
    asTenant(db, tenant, (trx) =>
      sql`INSERT INTO zvd_validation_test_cases (rule_id, label, input_value, expected_result, created_by)
          VALUES (${ruleId}::uuid, 'probe', 'v', true, 'test')`.execute(trx),
    );
  const casesOf = (ruleId: string) =>
    asEveryTenant(db, (trx) =>
      sql<{ tenant_id: string }>`
        SELECT tenant_id::text FROM zvd_validation_test_cases WHERE rule_id = ${ruleId}::uuid
         ORDER BY tenant_id`.execute(trx),
    ).then((r) => r.rows.map((x) => x.tenant_id));
  // writeValidationRule's shape: a tenant's request, the delete as the engine.
  const deleteInA = (ruleId: string) =>
    withTenantIsolation(A.id, (trx) =>
      asEngineRole(trx, () =>
        trx.deleteFrom('zv_validation_rules').where('id', '=', ruleId).execute(),
      ),
    );
  const runMigration = async (half: 'up' | 'down') => {
    const parsed = parseMigrationFile(await Bun.file(M097).text());
    await db.transaction().execute(async (trx) => {
      for (const stmt of splitSqlStatements(parsed[half] ?? '')) await sql.raw(stmt).execute(trx);
    });
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const t of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${t.id}::uuid, ${t.slug}, 'vtco', 'active')`.execute(db);
    }
    createdTable = !(
      await sql<{ ok: boolean }>`SELECT to_regclass(${T}) IS NOT NULL AS ok`.execute(db)
    ).rows[0]!.ok;
    if (createdTable) {
      // developer/validation's table as its 001-003 leave it.
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
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${C}`.execute(db);
    if (createdTable) await sql.raw(`DROP TABLE IF EXISTS ${T}`).execute(db);
    else {
      await asEveryTenant(db, (trx) =>
        sql`DELETE FROM zvd_validation_test_cases WHERE label = 'probe' AND created_by = 'test'`.execute(
          trx,
        ),
      );
    }
    for (const t of [A, B]) await sql`DELETE FROM zv_tenants WHERE id = ${t.id}::uuid`.execute(db);
  });

  it("an instance rule deleted from one tenant's request takes every tenant's test cases", async () => {
    const r = await rule();
    await testCase(A.id, r);
    await testCase(B.id, r);
    expect((await casesOf(r)).length).toBe(2);
    await deleteInA(r);
    expect(await casesOf(r)).toEqual([]);
  });

  it("097 deletes the test cases already orphaned, and its DOWN restores 096's trigger", async () => {
    const dead = crypto.randomUUID();
    await testCase(B.id, dead);
    await runMigration('up');
    expect(await casesOf(dead)).toEqual([]);

    await runMigration('down');
    const r = await rule();
    await testCase(B.id, r);
    const triggers = await sql<{ tgname: string }>`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'zv_validation_rules'::regclass AND tgname LIKE 'zv_forget%'`.execute(db);
    expect(triggers.rows.map((t) => t.tgname)).toEqual(['zv_forget_validation_rule_group_member']);
    await deleteInA(r);
    expect(await casesOf(r)).toEqual([B.id]);
    await runMigration('up');
    expect(await casesOf(r)).toEqual([]);
  });
});
