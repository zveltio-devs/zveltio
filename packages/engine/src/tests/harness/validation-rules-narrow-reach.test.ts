/**
 * A tenant's validation rules bind its writes whatever the caller's read reach.
 *
 * The rules are read inside the write's own tenant transaction, as the request
 * role, under migration 093's SELECT policy — `tenant_id IS NULL OR
 * zveltio_tenant_scope_ok(tenant_id)`, i.e. the caller's published READ set.
 * A caller whose assignments in the default tenant have all lapsed publishes
 * NO_UNITS there, and the membership gate did not refuse it then (the default
 * tenant counted everyone). Its read saw the instance rules only, and that short
 * list was cached under `collection@tenant` for 60 s and served to every other
 * writer of the tenant: their writes skipped the tenant's rules.
 *
 * The gate now refuses that caller (tenant-default-withdrawal.test.ts), so the
 * read is driven below it, in a tenant transaction resolved for that user — the
 * rules must hold whoever opened the transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { DEFAULT_TENANT_ID, withTenantIsolation } from '../../lib/tenancy/index.js';
import { getValidationRules, invalidateRulesCache } from '../../lib/validation-engine.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLL = `vrnr_${STAMP}`;

d('tenant validation rules ignore a narrowed read reach', () => {
  let app: Hono;
  let db: Database;
  let lapsed = '';
  let lapsedId = '';
  let writer = '';
  const users: string[] = [];

  const create = (cookie: string, score: number) =>
    app.request(`/api/data/${COLL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ score }),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'score', type: 'number', required: false, unique: false, indexed: false }],
    } as never);
    // A rule of the default tenant (an instance admin's `scope: 'tenant'`).
    await sql`INSERT INTO zv_validation_rules
                (collection, field_name, rule_type, rule_config, error_message, is_active, tenant_id)
              VALUES (${COLL}, 'score', 'max', ${JSON.stringify({ value: 100 })}::jsonb,
                      'Score must be 100 or less', TRUE, ${DEFAULT_TENANT_ID}::uuid)`.execute(db);
    const grants = [{ collection: COLL, actions: ['create', 'read'] }];
    const a = await createMemberSession(app, db, { grants });
    const b = await createMemberSession(app, db, { grants });
    users.push(a.userId, b.userId);
    lapsed = a.cookie;
    lapsedId = a.userId;
    writer = b.cookie;
    // Every assignment of `a` in the default tenant has ended: NO_UNITS.
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
              VALUES (${DEFAULT_TENANT_ID}::uuid, ${a.userId}, 'member',
                      now() - interval '2 days', now() - interval '1 day')
              ON CONFLICT (tenant_id, user_id) DO UPDATE
                SET valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLL}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE user_id = ANY(${users})`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLL}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLL).execute();
  });

  // Under the reach of a caller with no live unit, the way any path below the
  // membership gate opens it.
  const readAsLapsed = () =>
    withTenantIsolation(DEFAULT_TENANT_ID, (trx) => getValidationRules(trx, COLL, 'score'), {
      userId: lapsedId,
    });

  it('a caller with no live unit is refused at the door', async () => {
    expect((await create(lapsed, 500)).status).toBe(403);
  });

  it("a read under that caller's reach still sees the tenant's rules", async () => {
    invalidateRulesCache(COLL);
    expect((await readAsLapsed()).map((r) => r.rule_type)).toContain('max');
  });

  it('the writer alone is refused by the rule', async () => {
    invalidateRulesCache(COLL);
    expect((await create(writer, 500)).status).toBe(422);
  });

  it("nor does its read lift the tenant's rules off the next writer", async () => {
    invalidateRulesCache(COLL);
    await readAsLapsed();
    const res = await create(writer, 500);
    expect(res.status).toBe(422);
  });
});
