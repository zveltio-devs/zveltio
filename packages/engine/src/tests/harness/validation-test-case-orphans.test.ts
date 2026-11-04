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
 *
 * Since 111 the table is the engine's, and boot gives it the restrictive
 * `tenant_own_node_delete` (a DELETE in a tenant's request removes only that
 * tenant's rows); 097's trigger kept the request's tenant set and left every
 * other firm's test cases behind again. 112's trigger clears it for its DELETE.
 * Applied here as boot applies it, so the result does not depend on whether an
 * earlier file booted the reconcile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { toJsonb } from '../../lib/jsonb.js';
import { asEngineRole } from '../../lib/role-window.js';
import { reconcileExtensionTenantRLS, withTenantIsolation } from '../../lib/tenancy/index.js';
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
const M097 = new URL(
  '../../db/migrations/sql/097_validation_test_case_orphans.sql',
  import.meta.url,
).pathname;
const M112 = new URL(
  '../../db/migrations/sql/112_validation_rule_forget_every_tenant.sql',
  import.meta.url,
).pathname;

d('validation test cases follow their rule', () => {
  let db: Database;

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
  const runMigration = async (half: 'up' | 'down', file = M097) => {
    const parsed = parseMigrationFile(await Bun.file(file).text());
    await db.transaction().execute(async (trx) => {
      for (const stmt of splitSqlStatements(parsed[half] ?? '')) await sql.raw(stmt).execute(trx);
    });
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await reconcileExtensionTenantRLS(db, ['zvd_validation_test_cases']);
    for (const t of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${t.id}::uuid, ${t.slug}, 'vtco', 'active')`.execute(db);
    }
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${C}`.execute(db);
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zvd_validation_test_cases WHERE label = 'probe' AND created_by = 'test'`.execute(
        trx,
      ),
    );
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
    // 097 replaced the trigger function; put back the one the engine runs.
    await runMigration('up', M112);
  });
});
