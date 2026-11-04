/**
 * `/api/validation` is the engine's: the developer/validation extension that
 * held rule administration was retired, its routes moved here and its tables
 * were adopted by migration 111.
 *
 * Pinned: members are refused; an instance admin creates, lists, toggles and
 * deletes a rule (a duplicate instance rule is 409); test cases run through the
 * engine's evaluators and record their outcome; an import stores the good rules,
 * refuses an expression that cannot compile, and logs itself; a group takes
 * only instance rules of its own field; a deleted rule takes its test cases.
 * Between firms: a tenant admin's rule, test cases and import log are their
 * firm's, and another firm's admin can neither see, run nor delete them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const COLL = `vadm_${Date.now()}${Math.floor(Math.random() * 1e4)}`;

d('validation rule administration (in-process)', () => {
  let app: Hono;
  let db: Database;
  let admin: string;
  let member: string;
  let ruleId: string;

  const call = async (cookie: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/validation${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    admin = await createGodSession(app, db);
    member = (await createMemberSession(app, db)).cookie;
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_validation_rule_groups WHERE collection = ${COLL}`.execute(db);
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLL}`.execute(db);
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zvd_validation_import_log WHERE collection = ${COLL}`.execute(trx),
    );
  });

  it('refuses anonymous callers and members', async () => {
    expect((await app.request('/api/validation/rules')).status).toBe(401);
    expect((await call(member, 'GET', '/rules')).status).toBe(403);
    const write = await call(member, 'POST', '/rules', {
      collection: COLL,
      field_name: 'code',
      rule_type: 'required',
      error_message: 'x',
    });
    expect(write.status).toBe(403);
  });

  it('creates an instance rule, lists it, and refuses the same rule twice', async () => {
    const rule = {
      collection: COLL,
      field_name: 'qty',
      rule_type: 'nlp',
      rule_config: { expression: 'int(value) > 10' },
      error_message: 'qty must exceed 10',
    };
    const res = await call(admin, 'POST', '/rules', rule);
    expect(res.status).toBe(201);
    ruleId = res.body.rule.id;
    expect(res.body.rule.tenant_id).toBeNull();

    const list = await call(admin, 'GET', `/rules?collection=${COLL}`);
    expect(list.body.data.map((r: { id: string; scope: string }) => [r.id, r.scope])).toEqual([
      [ruleId, 'instance'],
    ]);
    expect((await call(admin, 'POST', '/rules', rule)).status).toBe(409);
  });

  it('refuses an expression that does not compile before it is stored', async () => {
    const res = await call(admin, 'POST', '/rules', {
      collection: COLL,
      field_name: 'qty',
      rule_type: 'nlp',
      rule_config: { expression: 'process.exit(1)' },
      error_message: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('runs a rule test cases through the engine evaluator and records the outcome', async () => {
    for (const [label, input_value, expected_result] of [
      ['big', '12', true],
      ['small', '3', false],
      ['wrong expectation', '4', true],
    ] as const) {
      const tc = await call(admin, 'POST', `/rules/${ruleId}/test-cases`, {
        label,
        input_value,
        expected_result,
      });
      expect(tc.status).toBe(201);
    }
    const run = await call(admin, 'POST', `/rules/${ruleId}/test-cases/run`);
    expect(run.status).toBe(200);
    expect({ total: run.body.total, passed: run.body.passed }).toEqual({ total: 3, passed: 2 });

    const cases = await call(admin, 'GET', `/rules/${ruleId}/test-cases`);
    expect(
      cases.body.test_cases.map((t: { label: string; last_run_result: boolean }) => [
        t.label,
        t.last_run_result,
      ]),
    ).toEqual([
      ['big', true],
      ['small', false],
      ['wrong expectation', false],
    ]);

    const bulk = await call(admin, 'POST', '/test-cases/run', { collection: COLL });
    expect({ total: bulk.body.total, failed: bulk.body.failed }).toEqual({ total: 3, failed: 1 });
  });

  it('imports the good rules, refuses the rest per row, and logs the import', async () => {
    const res = await call(admin, 'POST', '/rules/import', {
      collection: COLL,
      rules: [
        { field_name: 'code', rule_type: 'required', error_message: 'code is required' },
        {
          field_name: 'code',
          rule_type: 'nlp',
          rule_config: { expression: 'process.exit(1)' },
          error_message: 'x',
        },
        { field_name: 'code', rule_type: 'nope', error_message: 'x' },
      ],
    });
    expect(res.status).toBe(201);
    expect({ imported: res.body.imported, failed: res.body.failed }).toEqual({
      imported: 1,
      failed: 2,
    });
    const log = await asEveryTenant(db, (trx) =>
      sql<{ imported_count: number; failed_count: number }>`
        SELECT imported_count, failed_count FROM zvd_validation_import_log
         WHERE collection = ${COLL}`.execute(trx),
    );
    expect(log.rows).toEqual([{ imported_count: 1, failed_count: 2 }]);
  });

  it('groups only instance rules of the group field, once per name', async () => {
    const group = { name: 'g', collection: COLL, field_name: 'qty', rule_ids: [ruleId] };
    const res = await call(admin, 'POST', '/groups', { ...group, logic: 'OR' });
    expect(res.status).toBe(201);
    expect((await call(admin, 'POST', '/groups', group)).status).toBe(409);
    const otherField = await call(admin, 'POST', '/groups', {
      ...group,
      name: 'h',
      field_name: 'code',
    });
    expect(otherField.status).toBe(400);

    const groups = await call(admin, 'GET', `/groups?collection=${COLL}`);
    expect(groups.body.groups.map((g: { name: string }) => g.name)).toEqual(['g']);
    expect((await call(admin, 'DELETE', `/groups/${res.body.group.id}`)).status).toBe(200);
    expect((await call(admin, 'DELETE', `/groups/${res.body.group.id}`)).status).toBe(404);
  });

  it('toggles and deletes a rule, whose test cases go with it', async () => {
    const off = await call(admin, 'PATCH', `/rules/${ruleId}`, { is_active: 'false' });
    expect(off.body.rule.is_active).toBe(false);
    expect((await call(admin, 'DELETE', `/rules/${ruleId}`)).status).toBe(200);
    expect((await call(admin, 'DELETE', `/rules/${ruleId}`)).status).toBe(404);
    const left = await asEveryTenant(db, (trx) =>
      sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zvd_validation_test_cases WHERE rule_id = ${ruleId}`.execute(
        trx,
      ),
    );
    expect(left.rows[0]?.n).toBe(0);
  });
});

d('validation rule administration between firms (in-process)', () => {
  const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const C = `vadt_${STAMP}`;
  const A = { id: crypto.randomUUID(), slug: `vadt-a-${STAMP}` };
  const B = { id: crypto.randomUUID(), slug: `vadt-b-${STAMP}` };
  let app: Hono;
  let db: Database;
  let god: string;
  const admins: Record<'A' | 'B', { cookie: string; userId: string }> = {
    A: { cookie: '', userId: '' },
    B: { cookie: '', userId: '' },
  };
  let instanceRule = '';
  let bRule = '';
  let bCaseOnB = '';
  let bCaseOnInstance = '';

  const as = async (
    who: 'A' | 'B',
    method: string,
    path: string,
    body?: unknown,
    slug?: string,
  ) => {
    const res = await app.request(`/api/validation${path}`, {
      method,
      headers: {
        cookie: admins[who].cookie,
        'x-tenant-slug': slug ?? (who === 'A' ? A.slug : B.slug),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const cases = async () =>
    (
      await asEveryTenant(db, (trx) =>
        sql<{ id: string; tenant_id: string; last_run_result: boolean | null }>`
          SELECT tc.id, tc.tenant_id::text AS tenant_id, tc.last_run_result
            FROM zvd_validation_test_cases tc JOIN zv_validation_rules r ON r.id = tc.rule_id
           WHERE r.collection = ${C}`.execute(trx),
      )
    ).rows;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    const enforcer = await getEnforcer();
    for (const [who, firm] of [
      ['A', A],
      ['B', B],
    ] as const) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${firm.id}::uuid, ${firm.slug}, ${firm.slug}, 'active')`.execute(db);
      const m = await createMemberSession(app, db, { configWindow: true });
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
                VALUES (${firm.id}::uuid, ${m.userId}, 'member')`.execute(db);
      await enforcer.addPolicy(m.userId, firm.id, 'admin', '*');
      await invalidateUserPermCache(m.userId);
      admins[who] = m;
    }
    const res = await app.request('/api/validation/rules', {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({
        collection: C,
        field_name: 'code',
        rule_type: 'required',
        error_message: 'code is required',
      }),
    });
    instanceRule = ((await res.json()) as { rule: { id: string } }).rule.id;
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${C}`.execute(db);
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zvd_validation_import_log WHERE collection = ${C}`.execute(trx),
    );
    for (const m of Object.values(admins)) {
      await sql`DELETE FROM zvd_permissions WHERE v0 = ${m.userId}`.execute(db);
      await sql`DELETE FROM "user" WHERE id = ${m.userId}`.execute(db);
    }
    for (const firm of [A, B]) {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${firm.id}::uuid`.execute(db);
      await sql`DELETE FROM zv_tenants WHERE id = ${firm.id}::uuid`.execute(db);
    }
  });

  it("a firm admin's rule and test cases land on their firm", async () => {
    const rule = await as('B', 'POST', '/rules', {
      collection: C,
      field_name: 'code',
      rule_type: 'minLength',
      rule_config: { value: 3 },
      error_message: 'at least 3',
    });
    expect(rule.status).toBe(201);
    expect(rule.body.rule.tenant_id).toBe(B.id);
    bRule = rule.body.rule.id;
    const tc = { label: 'short', input_value: 'ab', expected_result: false };
    bCaseOnB = (await as('B', 'POST', `/rules/${bRule}/test-cases`, tc)).body.test_case.id;
    const onInstance = await as('B', 'POST', `/rules/${instanceRule}/test-cases`, tc);
    expect(onInstance.status).toBe(201);
    bCaseOnInstance = onInstance.body.test_case.id;
    expect(await cases()).toEqual(
      expect.arrayContaining([
        { id: bCaseOnB, tenant_id: B.id, last_run_result: null },
        { id: bCaseOnInstance, tenant_id: B.id, last_run_result: null },
      ]),
    );
  });

  it("another firm's admin can neither see, run nor change them", async () => {
    const list = await as('A', 'GET', `/rules?collection=${C}`);
    expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([instanceRule]);
    expect((await as('A', 'GET', `/rules/${bRule}/test-cases`)).status).toBe(404);
    const add = { label: 'x', input_value: 'x', expected_result: true };
    expect((await as('A', 'POST', `/rules/${bRule}/test-cases`, add)).status).toBe(404);
    expect((await as('A', 'POST', `/rules/${bRule}/test-cases/run`)).status).toBe(404);
    expect((await as('A', 'PATCH', `/rules/${bRule}`, { is_active: false })).status).toBe(404);
    expect((await as('A', 'DELETE', `/rules/${bRule}`)).status).toBe(404);
    expect((await as('A', 'DELETE', `/rules/${bRule}/test-cases/${bCaseOnB}`)).status).toBe(404);
    const onInstance = `/rules/${instanceRule}/test-cases`;
    expect((await as('A', 'GET', onInstance)).body.test_cases).toEqual([]);
    expect((await as('A', 'DELETE', `${onInstance}/${bCaseOnInstance}`)).status).toBe(404);
    expect((await as('A', 'POST', `${onInstance}/run`)).body.total).toBe(0);
    expect((await as('A', 'POST', '/test-cases/run', { collection: C })).body.total).toBe(0);
    // Nothing of B's moved: both cases still there, never run.
    expect(await cases()).toEqual(
      expect.arrayContaining([
        { id: bCaseOnB, tenant_id: B.id, last_run_result: null },
        { id: bCaseOnInstance, tenant_id: B.id, last_run_result: null },
      ]),
    );
    expect(await cases()).toHaveLength(2);
    // Naming the other firm does not make A its admin.
    expect((await as('A', 'GET', `/rules/${bRule}/test-cases`, undefined, B.slug)).status).not.toBe(
      200,
    );
    expect(
      (
        await as('A', 'POST', '/groups', {
          name: 'g',
          collection: C,
          field_name: 'code',
          rule_ids: [instanceRule],
        })
      ).status,
    ).toBe(403);
  });

  it("the owning firm runs its own cases; an import is logged on the importer's firm", async () => {
    const run = await as('B', 'POST', '/test-cases/run', { collection: C });
    expect({ total: run.body.total, passed: run.body.passed }).toEqual({ total: 2, passed: 1 });
    const imp = await as('A', 'POST', '/rules/import', {
      collection: C,
      rules: [{ field_name: 'name', rule_type: 'required', error_message: 'name' }],
    });
    expect(imp.status).toBe(201);
    const log = await asEveryTenant(db, (trx) =>
      sql<{ t: string }>`
        SELECT tenant_id::text AS t FROM zvd_validation_import_log WHERE collection = ${C}`.execute(
        trx,
      ),
    );
    expect(log.rows).toEqual([{ t: A.id }]);
  });
});
