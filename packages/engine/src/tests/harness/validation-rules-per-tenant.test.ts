/**
 * Per-tenant validation rules, tighten-only (migration 092).
 *
 * A rule with `tenant_id` NULL binds every tenant; a rule with a tenant id binds
 * that tenant's writes only, ANDed on top of the instance rules. A tenant admin
 * writes, toggles and deletes rules of their own tenant through
 * `ctx.internals.writeValidationRule` (the engine sets the tenant), and cannot
 * touch an instance rule or another tenant's. A rule group (instance-wide)
 * never lets a tenant rule satisfy it, so a tenant rule cannot relax an
 * instance rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { processInput } from '../../lib/data/write-pipeline.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { exportSchema } from '../../lib/schema-artifact/export.js';
import { invalidateRulesCache, resetRuleGroupsTableProbe } from '../../lib/validation-engine.js';
import {
  ALL_COLLECTIONS_ACTOR,
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import {
  getEnforcer,
  invalidateUserPermCache,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLL = `vrpt_${STAMP}`;
const PROBE = `vrpt-probe-${STAMP}`;
const A = { id: crypto.randomUUID(), slug: `vrpt-a-${STAMP}` };
const B = { id: crypto.randomUUID(), slug: `vrpt-b-${STAMP}` };
const GROUPS = 'zvd_validation_rule_groups';

d('validation rules per tenant, tighten-only', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let god: Record<string, string> = {};
  let adminA: Record<string, string> = {};
  let adminB: Record<string, string> = {};
  const userIds: string[] = [];
  let createdGroupsTable = false;

  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(`/ext/${PROBE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const create = async (headers: Record<string, string>, rule: object, scope?: string) => {
    const res = await call('POST', '/rules', headers, {
      rule: { collection: COLL, ...rule },
      scope,
    });
    return { status: res.status, body: (await res.json()) as { row?: Record<string, unknown> } };
  };
  const rule = (id: string) =>
    sql<{ is_active: boolean; tenant_id: string | null }>`
      SELECT is_active, tenant_id FROM zv_validation_rules WHERE id = ${id}::uuid`
      .execute(db)
      .then((r) => r.rows[0]);
  /** The errors a write of `code` gets in `tenant` (null: no tenant transaction). */
  const errorsIn = async (tenant: string | null, code: string) => {
    const def = await DDLManager.getCollection(db, COLL);
    const run = () => processInput({ code }, def, false, null).then((r) => r.errors);
    return tenant ? withTenantIsolation(tenant, run, { identity: ALL_COLLECTIONS_ACTOR }) : run();
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    god = { cookie: await createGodSession(engine, db) };
    for (const t of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${t.id}::uuid, ${t.slug}, 'vrpt', 'active')`.execute(db);
    }
    for (const [t, set] of [
      [A, (h: Record<string, string>) => (adminA = h)],
      [B, (h: Record<string, string>) => (adminB = h)],
    ] as const) {
      const m = await createMemberSession(engine, db);
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
                VALUES (${t.id}::uuid, ${m.userId}, 'member')`.execute(db);
      await (await getEnforcer()).addPolicy(m.userId, t.id, 'admin', '*');
      await invalidateUserPermCache(m.userId);
      userIds.push(m.userId);
      set({ cookie: m.cookie, 'x-tenant-slug': t.slug });
    }
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'code', type: 'text', required: false, unique: false, indexed: false }],
    } as never);

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    const probe: ZveltioExtension = {
      name: PROBE,
      category: 'custom',
      mountStrategy: 'subapp',
      async register(sub, ctx) {
        const w = ctx.internals.writeValidationRule;
        const answer = async (run: () => Promise<unknown>) => {
          try {
            return Response.json({ row: await run() });
          } catch (err) {
            return Response.json({ refused: (err as Error).message }, { status: 403 });
          }
        };
        sub.post('/rules', async (c) => {
          const { rule: r, scope } = await c.req.json();
          return answer(() => w(c, { op: 'create', rule: r, scope }));
        });
        sub.patch('/rules/:id', async (c) =>
          answer(async () =>
            w(c, {
              op: 'setActive',
              id: c.req.param('id'),
              is_active: (await c.req.json()).is_active,
            }),
          ),
        );
        sub.delete('/rules/:id', async (c) =>
          answer(() => w(c, { op: 'delete', id: c.req.param('id') })),
        );
      },
    };
    await sql`DELETE FROM zv_extension_registry WHERE name = ${PROBE}`.execute(db);
    await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
              VALUES (${PROBE}, ${PROBE}, NULL, true, true)`.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    await finalizeExtensionLoad(
      loader,
      probe,
      PROBE,
      `/tmp/${PROBE}`,
      app,
      ctx,
      { name: PROBE, version: '1.0.0', category: 'custom', permissions: [] } as never,
      new Set(),
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLL}`.execute(db);
    if (createdGroupsTable) await sql.raw(`DROP TABLE IF EXISTS ${GROUPS}`).execute(db);
    else await sql`DELETE FROM zvd_validation_rule_groups WHERE collection = ${COLL}`.execute(db);
    resetRuleGroupsTableProbe(db);
    await sql`DELETE FROM zv_audit_log WHERE resource_type = 'validation_rule' AND metadata->>'collection' = ${COLL}`.execute(
      db,
    );
    await sql`DELETE FROM zv_extension_registry WHERE name = ${PROBE}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLL}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLL).execute();
    for (const id of userIds) {
      await sql`DELETE FROM zvd_permissions WHERE v0 = ${id}`.execute(db);
      await sql`DELETE FROM zv_tenant_users WHERE user_id = ${id}`.execute(db);
      await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db);
    }
    for (const t of [A, B]) await sql`DELETE FROM zv_tenants WHERE id = ${t.id}::uuid`.execute(db);
  });

  let ruleA = '';
  let instanceRule = '';

  it("a rule of tenant A binds A's writes only; an instance rule binds both", async () => {
    const a = await create(adminA, {
      field_name: 'code',
      rule_type: 'minLength',
      rule_config: { value: 5 },
      error_message: 'A wants 5+',
      // Ignored: the engine decides the tenant.
      tenant_id: B.id,
    });
    expect(a.status).toBe(200);
    ruleA = String(a.body.row!.id);
    expect(a.body.row!.tenant_id).toBe(A.id);

    const inst = await create(god, {
      field_name: 'code',
      rule_type: 'maxLength',
      rule_config: { value: 10 },
      error_message: 'at most 10',
    });
    expect(inst.status).toBe(200);
    instanceRule = String(inst.body.row!.id);
    expect(inst.body.row!.tenant_id).toBeNull();

    // A first, so a cache keyed by collection alone would serve A's rules to B.
    expect((await errorsIn(A.id, 'abc')).join()).toContain('A wants 5+');
    expect(await errorsIn(B.id, 'abc')).toEqual([]);
    expect(await errorsIn(null, 'abc')).toEqual([]);
    expect(await errorsIn(A.id, 'abcdef')).toEqual([]);
    for (const t of [A.id, B.id, null]) {
      expect((await errorsIn(t, 'abcdefghijkl')).join()).toContain('at most 10');
    }

    // The schema file carries instance rules only.
    const files = JSON.stringify(await exportSchema(db));
    expect(files).toContain('at most 10');
    expect(files).not.toContain('A wants 5+');
  });

  it("a tenant admin cannot touch an instance rule or another tenant's rule", async () => {
    // B on A's rule, A on the instance rule: no such rule for them.
    for (const [who, id] of [
      [adminB, ruleA],
      [adminA, instanceRule],
    ] as const) {
      const off = await call('PATCH', `/rules/${id}`, who, { is_active: false });
      expect(((await off.json()) as { row: unknown }).row).toBeNull();
      const del = await call('DELETE', `/rules/${id}`, who);
      expect(((await del.json()) as { row: unknown }).row).toBeNull();
      expect((await rule(id))?.is_active).toBe(true);
    }
    const inst = await create(
      adminA,
      { field_name: 'code', rule_type: 'required', error_message: 'x' },
      'instance',
    );
    expect(inst.status).toBe(403);

    // Their own: toggled and deleted, audited in their tenant.
    expect((await call('PATCH', `/rules/${ruleA}`, adminA, { is_active: false })).status).toBe(200);
    expect((await rule(ruleA))?.is_active).toBe(false);
    expect(await errorsIn(A.id, 'abc')).toEqual([]);
    expect((await call('DELETE', `/rules/${ruleA}`, adminA)).status).toBe(200);
    expect(await rule(ruleA)).toBeUndefined();

    await _settleAuditWrites();
    // Read each scope where its rows are visible: a NOBYPASSRLS owner sees a
    // tenant's audit rows only from inside that tenant.
    const trailIn = (q: Database) =>
      sql<{ resource_id: string; event_type: string; tenant_id: string | null }>`
        SELECT resource_id, event_type, tenant_id FROM zv_audit_log
         WHERE resource_type = 'validation_rule' AND metadata->>'collection' = ${COLL}
         ORDER BY created_at, id`
        .execute(q)
        .then((r) => r.rows);
    expect(await withTenantIsolation(A.id, (trx) => trailIn(trx as Database))).toEqual([
      { resource_id: ruleA, event_type: 'validation_rule.created', tenant_id: A.id },
      { resource_id: ruleA, event_type: 'validation_rule.updated', tenant_id: A.id },
      { resource_id: ruleA, event_type: 'validation_rule.deleted', tenant_id: A.id },
    ]);
    expect((await trailIn(db)).filter((r) => r.tenant_id === null)).toEqual([
      { resource_id: instanceRule, event_type: 'validation_rule.created', tenant_id: null },
    ]);
  });

  it('an instance admin may write a rule for the request tenant only by asking', async () => {
    const own = await create(
      { ...god, 'x-tenant-slug': B.slug },
      {
        field_name: 'code',
        rule_type: 'pattern',
        rule_config: { pattern: '^b' },
        error_message: 'B: b…',
      },
      'tenant',
    );
    expect(own.status).toBe(200);
    expect(own.body.row!.tenant_id).toBe(B.id);
    expect((await errorsIn(B.id, 'xyz')).join()).toContain('B: b…');
    expect(await errorsIn(A.id, 'xyz')).toEqual([]);
    await call('DELETE', `/rules/${own.body.row!.id}`, god);
  });

  it('a tenant rule in an OR group never relaxes an instance rule', async () => {
    createdGroupsTable = !(
      await sql<{ p: boolean }>`SELECT to_regclass(${GROUPS}) IS NOT NULL AS p`.execute(db)
    ).rows[0]!.p;
    await sql
      .raw(`CREATE TABLE IF NOT EXISTS ${GROUPS} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, collection TEXT NOT NULL,
      field_name TEXT NOT NULL, description TEXT, logic TEXT NOT NULL DEFAULT 'AND',
      rule_ids UUID[] NOT NULL DEFAULT '{}', is_active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
      .execute(db);
    resetRuleGroupsTableProbe(db);
    // A's rule accepts anything of 1+ characters: as an OR member it would
    // satisfy the group for A and lift the instance's "at most 10".
    const lax = await create(adminA, {
      field_name: 'code',
      rule_type: 'minLength',
      rule_config: { value: 1 },
      error_message: 'A: 1+',
    });
    await sql`INSERT INTO zvd_validation_rule_groups (name, collection, field_name, logic, rule_ids, created_by)
              VALUES ('either', ${COLL}, 'code', 'OR',
                      ARRAY[${instanceRule}, ${String(lax.body.row!.id)}]::uuid[], 'test')`.execute(
      db,
    );
    invalidateRulesCache(COLL);
    expect((await errorsIn(A.id, 'abcdefghijkl')).join()).toContain('at most 10');
    expect(await errorsIn(A.id, 'abc')).toEqual([]);
  });

  it('092 DOWN is refused while a tenant rule exists', async () => {
    const { down } = parseMigrationFile(
      await Bun.file(
        new URL('../../db/migrations/sql/092_validation_rules_per_tenant.sql', import.meta.url),
      ).text(),
    );
    let refused = '';
    try {
      // Always rolled back: a DOWN that went through would drop the column here.
      await db.transaction().execute(async (trx) => {
        await sql`INSERT INTO zv_validation_rules (collection, field_name, rule_type, error_message, tenant_id)
                  VALUES (${COLL}, 'code', 'required', 'x', ${A.id}::uuid)`.execute(trx);
        for (const stmt of splitSqlStatements(down ?? '')) await sql.raw(stmt).execute(trx);
        throw new Error('DOWN went through');
      });
    } catch (err) {
      refused = (err as Error).message;
    }
    expect(refused).toContain('tenant validation rule');
    const col = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'zv_validation_rules' AND column_name = 'tenant_id'`.execute(db);
    expect(col.rows[0]!.n).toBe(1);
  });
});
