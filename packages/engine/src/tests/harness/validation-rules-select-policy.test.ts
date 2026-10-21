/**
 * `zv_validation_rules` under a SELECT policy (migration 093).
 *
 * 092 gave a rule a tenant, and the request role still read every row:
 * `zveltio_rls` in tenant B selected tenant A's rule. Now a request role sees
 * instance rules and its own tenant's; the evaluator, which reads on the pool as
 * the table owner, still sees what each write needs. The policy must stay out
 * of the boot reconciler's `tenant_isolation_*` sweep, which would move every
 * instance rule to the default tenant and force the table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { processInput } from '../../lib/data/write-pipeline.js';
import { invalidateRulesCache } from '../../lib/validation-engine.js';
import { ALL_COLLECTIONS_ACTOR, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { reconcileExtensionTenantRLS } from '../../lib/tenancy/tenant-manager.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLL = `vrsp_${STAMP}`;
const A = { id: crypto.randomUUID(), slug: `vrsp-a-${STAMP}` };
const B = { id: crypto.randomUUID(), slug: `vrsp-b-${STAMP}` };

d('validation rules SELECT policy', () => {
  let db: Database;

  /** What a request in `tenant` reads, as the request role. */
  const seenIn = (tenant: string) =>
    withTenantIsolation(
      tenant,
      async (trx) => {
        const who = await sql<{ u: string }>`SELECT current_user AS u`.execute(trx);
        // Not vacuous: the read below runs as the request role, not the owner.
        expect(who.rows[0]!.u).toBe('zveltio_rls');
        const r = await sql<{ error_message: string }>`
          SELECT error_message FROM zv_validation_rules WHERE collection = ${COLL}
           ORDER BY error_message`.execute(trx);
        return r.rows.map((x) => x.error_message);
      },
      { identity: ALL_COLLECTIONS_ACTOR },
    );
  const errorsIn = async (tenant: string | null, code: string) => {
    const def = await DDLManager.getCollection(db, COLL);
    const run = () => processInput({ code }, def, false, null).then((r) => r.errors);
    return (
      tenant ? withTenantIsolation(tenant, run, { identity: ALL_COLLECTIONS_ACTOR }) : run()
    ).then((e) => e.join());
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const t of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${t.id}::uuid, ${t.slug}, 'vrsp', 'active')`.execute(db);
    }
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'code', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`INSERT INTO zv_validation_rules (collection, field_name, rule_type, rule_config, error_message, tenant_id)
              VALUES (${COLL}, 'code', 'maxLength', '{"value": 10}', 'instance: at most 10', NULL),
                     (${COLL}, 'code', 'minLength', '{"value": 5}', 'A: 5+', ${A.id}::uuid),
                     (${COLL}, 'code', 'pattern', '{"pattern": "^b"}', 'B: b...', ${B.id}::uuid)`.execute(
      db,
    );
    invalidateRulesCache(COLL);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLL}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLL}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLL).execute();
    for (const t of [A, B]) await sql`DELETE FROM zv_tenants WHERE id = ${t.id}::uuid`.execute(db);
  });

  it("a request role reads instance rules and its own tenant's, never another's", async () => {
    expect(await seenIn(B.id)).toEqual(['B: b...', 'instance: at most 10']);
    expect(await seenIn(A.id)).toEqual(['A: 5+', 'instance: at most 10']);
  });

  it('the evaluator, reading as the owner, still applies each tenant its rules', async () => {
    expect(await errorsIn(A.id, 'abc')).toContain('A: 5+');
    expect(await errorsIn(B.id, 'abc')).toContain('B: b...');
    expect(await errorsIn(B.id, 'abc')).not.toContain('A: 5+');
    expect(await errorsIn(null, 'abc')).toBe('');
    for (const t of [A.id, B.id, null]) {
      expect(await errorsIn(t, 'bbbbbbbbbbbb')).toContain('instance: at most 10');
    }
  });

  it('is not FORCEd and survives the boot reconciler', async () => {
    // FORCE would bind the owner's pool read, which has no tenant set: every
    // tenant rule would vanish from the evaluator and its writes pass unchecked.
    await reconcileExtensionTenantRLS(db, ['zv_validation_rules']);
    const t = await sql<{ forced: boolean }>`
      SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.zv_validation_rules'::regclass`.execute(
      db,
    );
    expect(t.rows[0]!.forced).toBe(false);
    const inst = await sql<{ tenant_id: string | null }>`
      SELECT tenant_id FROM zv_validation_rules
       WHERE collection = ${COLL} AND error_message = 'instance: at most 10'`.execute(db);
    expect(inst.rows[0]!.tenant_id).toBeNull();
  });
});
