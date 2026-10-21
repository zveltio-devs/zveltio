/**
 * `zvd_validation_rule_groups` is instance-wide, like the rules it combines.
 *
 * Measured on master: the `developer/validation` extension gave the table a
 * tenant column and a policy (its 002), wrote it through `ctx.db` inside one
 * tenant, and the request role held INSERT, UPDATE and DELETE on it. A group
 * turns a field's rules from AND into OR, the rules bind every tenant, and the
 * evaluator caches groups per collection — so one tenant's group decided the
 * next tenant's writes until the cache expired.
 *
 * Now migration 091 drops the column and the policy (keeping rows: on a
 * (collection, name) clash the default tenant's row wins), the request and
 * extension roles only read the table, and the one writer is
 * `ctx.internals.writeValidationRuleGroup`: as the engine, for an instance admin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { runExtensionMigrations } from '../../lib/extensions/migration-runner.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import {
  DEFAULT_TENANT_ID,
  getEnforcer,
  invalidateUserPermCache,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const PROBE = `vrg-probe-${STAMP}`;
const C1 = `vrg1_${STAMP}`;
const C2 = `vrg2_${STAMP}`;
const FIRM = { id: crypto.randomUUID(), slug: `vrg-${STAMP}` };
const OTHER_FIRM = crypto.randomUUID();
const T = 'zvd_validation_rule_groups';
const MIGRATION = new URL(
  '../../db/migrations/sql/091_validation_rule_groups_instance_wide.sql',
  import.meta.url,
).pathname;

// The table as developer/validation's 001 creates it and its 002 polices it.
const EXT_001 = `CREATE TABLE IF NOT EXISTS ${T} (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  collection TEXT NOT NULL,
  field_name TEXT NOT NULL,
  description TEXT,
  logic TEXT NOT NULL DEFAULT 'AND' CHECK (logic IN ('AND','OR')),
  rule_ids UUID[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;
const EXT_002 = `ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE ${T} ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '${DEFAULT_TENANT_ID}'::uuid);
CREATE INDEX IF NOT EXISTS idx_${T}_tenant ON ${T} (tenant_id);
ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${T} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_${T} ON ${T};
CREATE POLICY tenant_isolation_${T} ON ${T}
  USING (zveltio_tenant_scope_ok(tenant_id)) WITH CHECK (zveltio_tenant_scope_ok(tenant_id));`;

d('validation rule groups are instance-wide', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let godCookie = '';
  let firmAdmin = { cookie: '', userId: '' };
  const tmp = `/tmp/${PROBE}`;

  const runMigration = async (half: 'up' | 'down') => {
    const parsed = parseMigrationFile(await Bun.file(MIGRATION).text());
    await db.transaction().execute(async (trx) => {
      for (const stmt of splitSqlStatements(parsed[half] ?? '')) await sql.raw(stmt).execute(trx);
    });
  };
  const groups = async (collection = C1) =>
    (
      await sql<{ id: string; name: string }>`
        SELECT id, name FROM zvd_validation_rule_groups WHERE collection = ${collection}
         ORDER BY name`.execute(db)
    ).rows;
  const hasColumn = async (col: string) =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_attribute
         WHERE attrelid = ${T}::regclass AND attname = ${col} AND NOT attisdropped`.execute(db)
    ).rows[0]!.n === 1;
  const rls = async () =>
    (
      await sql<{ on: boolean; forced: boolean; policies: number }>`
        SELECT relrowsecurity AS on, relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policies WHERE tablename = ${T}) AS policies
          FROM pg_class WHERE oid = ${T}::regclass`.execute(db)
    ).rows[0]!;
  const asRls = async (tenant: string, q: ReturnType<typeof sql>): Promise<string> => {
    try {
      await withTenantIsolation(tenant, (trx) => q.execute(trx));
      return 'ALLOWED';
    } catch (err) {
      return (err as Error).message;
    }
  };
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(`/ext/${PROBE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    godCookie = await createGodSession(engine, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${FIRM.id}::uuid, ${FIRM.slug}, 'vrg', 'active')`.execute(db);
    const m = await createMemberSession(engine, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${FIRM.id}::uuid, ${m.userId}, 'member')`.execute(db);
    await (await getEnforcer()).addPolicy(m.userId, FIRM.id, 'admin', '*');
    await invalidateUserPermCache(m.userId);
    firmAdmin = m;

    // A test database: the extension is not installed here, its table is ours.
    await sql`DROP TABLE IF EXISTS zvd_validation_rule_groups`.execute(db);
    await Bun.write(`${tmp}/001_initial.sql`, EXT_001);
    await Bun.write(`${tmp}/002_tenant_rls.sql`, EXT_002);

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    const probe: ZveltioExtension = {
      name: PROBE,
      category: 'custom',
      mountStrategy: 'subapp',
      getMigrations: () => [`${tmp}/001_initial.sql`, `${tmp}/002_tenant_rls.sql`],
      async register(sub, ctx) {
        const w = ctx.internals.writeValidationRuleGroup;
        const answer = async (run: () => Promise<unknown>) => {
          try {
            return Response.json({ row: await run() });
          } catch (err) {
            const e = err as Error & { errno?: string };
            return Response.json({ refused: e.message, errno: e.errno }, { status: 403 });
          }
        };
        sub.post('/groups', async (c) =>
          answer(async () => w(c, { op: 'create', group: await c.req.json() })),
        );
        sub.delete('/groups/:id', async (c) =>
          answer(() => w(c, { op: 'delete', id: c.req.param('id') })),
        );
      },
    };
    await sql`DELETE FROM zv_extension_registry WHERE name = ${PROBE}`.execute(db);
    await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
              VALUES (${PROBE}, ${PROBE}, NULL, true, true)`.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    // The table arrives the way an install made at run time creates it.
    await runExtensionMigrations(probe, db);
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
      tmp,
      app,
      ctx,
      { name: PROBE, version: '1.0.0', category: 'custom', permissions: [] } as never,
      new Set(),
    );
    invalidateActivationCache();
  }, 120_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DROP TABLE IF EXISTS zvd_validation_rule_groups`.execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${PROBE}:%`}`.execute(db);
    await sql`DELETE FROM zv_audit_log WHERE resource_type = 'validation_rule_group'
                AND metadata->>'collection' IN (${C1}, ${C2})`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${PROBE}`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${firmAdmin.userId}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${FIRM.id}::uuid`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${firmAdmin.userId}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${FIRM.id}::uuid`.execute(db);
  });

  it('an extension install at run time leaves the table read-only to zveltio_rls', async () => {
    const write = await asRls(
      DEFAULT_TENANT_ID,
      sql`INSERT INTO zvd_validation_rule_groups (name, collection, field_name, created_by)
          VALUES ('rls', ${C1}, 'code', 'x')`,
    );
    expect(write).toMatch(/permission denied/i);
  });

  it('091 keeps the rows, and on a name clash the default tenant wins', async () => {
    // Seeded as the owner without FORCE: the policy would refuse a NULL tenant.
    const seed: Array<[string, string, string | null, string]> = [
      // name, collection, tenant, created_at
      ['dup', C1, FIRM.id, '2026-01-01'],
      ['dup', C1, DEFAULT_TENANT_ID, '2026-03-01'],
      ['dup', C1, null, '2026-02-01'],
      ['legacy', C1, FIRM.id, '2026-01-01'],
      ['legacy', C1, null, '2026-02-01'],
      ['firms', C1, OTHER_FIRM, '2026-02-01'],
      ['firms', C1, FIRM.id, '2026-01-01'],
      ['solo', C2, FIRM.id, '2026-01-01'],
    ];
    const ids = new Map<string, string>();
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE zvd_validation_rule_groups NO FORCE ROW LEVEL SECURITY`.execute(trx);
      for (const [name, collection, tenant, at] of seed) {
        const r = await sql<{ id: string }>`
          INSERT INTO zvd_validation_rule_groups (name, collection, field_name, tenant_id, created_by, created_at)
          VALUES (${name}, ${collection}, 'code', ${tenant}::uuid, 'seed', ${at}::timestamptz)
          RETURNING id`.execute(trx);
        ids.set(`${name}/${tenant}`, r.rows[0]!.id);
      }
      await sql`ALTER TABLE zvd_validation_rule_groups FORCE ROW LEVEL SECURITY`.execute(trx);
    });

    await runMigration('up');
    const expected = [
      { id: ids.get(`dup/${DEFAULT_TENANT_ID}`)!, name: 'dup' },
      { id: ids.get(`firms/${FIRM.id}`)!, name: 'firms' }, // oldest of two firms
      { id: ids.get('legacy/null')!, name: 'legacy' }, // NULL outranks a firm
    ];
    expect(await groups()).toEqual(expected);
    expect(await groups(C2)).toEqual([{ id: ids.get(`solo/${FIRM.id}`)!, name: 'solo' }]);
    expect(await hasColumn('tenant_id')).toBe(false);
    expect(await rls()).toEqual({ on: false, forced: false, policies: 0 });

    // Idempotent: the extension's own 004 runs the same on an install after it.
    await runMigration('up');
    expect(await groups()).toEqual(expected);
  });

  it('every tenant reads every group; a direct write is still refused', async () => {
    const seen = await withTenantIsolation(FIRM.id, (trx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM zvd_validation_rule_groups
                          WHERE collection = ${C1}`.execute(trx),
    );
    expect(seen.rows[0]!.n).toBe(3);
    const write = await asRls(
      FIRM.id,
      sql`DELETE FROM zvd_validation_rule_groups WHERE collection = ${C1}`,
    );
    expect(write).toMatch(/permission denied/i);
    expect(await groups()).toHaveLength(3);
  });

  it('refuses the admin of a firm, and lets an instance admin create and delete', async () => {
    const group = { name: 'either', collection: C2, field_name: 'code', logic: 'OR', rule_ids: [] };
    const asFirm = { cookie: firmAdmin.cookie, 'x-tenant-slug': FIRM.slug };
    const refused = await call('POST', '/groups', asFirm, group);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { refused: string }).refused).toContain('instance admin');
    expect((await groups(C2)).map((g) => g.name)).toEqual(['solo']);

    const god = { cookie: godCookie };
    const created = await call('POST', '/groups', god, group);
    expect(created.status).toBe(200);
    const row = ((await created.json()) as { row: { id: string; logic: string } }).row;
    expect(row.logic).toBe('OR');
    expect((await groups(C2)).map((g) => g.name)).toEqual(['either', 'solo']);

    // A name is unique per collection now.
    const again = await call('POST', '/groups', god, group);
    expect(((await again.json()) as { errno: string }).errno).toBe('23505');

    expect((await call('DELETE', `/groups/${row.id}`, asFirm)).status).toBe(403);
    expect((await groups(C2)).map((g) => g.name)).toEqual(['either', 'solo']);
    expect((await call('DELETE', `/groups/${row.id}`, god)).status).toBe(200);
    expect((await groups(C2)).map((g) => g.name)).toEqual(['solo']);

    await _settleAuditWrites();
    const trail = await sql<{ event_type: string; tenant_id: string | null }>`
      SELECT event_type, tenant_id FROM zv_audit_log
       WHERE resource_type = 'validation_rule_group' AND resource_id = ${row.id}
       ORDER BY created_at, id`.execute(db);
    expect(trail.rows).toEqual([
      { event_type: 'validation_rule_group.created', tenant_id: null },
      { event_type: 'validation_rule_group.deleted', tenant_id: null },
    ]);
  });

  it('no request role holds a write on it', async () => {
    const r = await sql<{ w: string }>`
      SELECT r.rolname || ' ' || p AS w
        FROM pg_roles r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) p
       WHERE r.rolname IN ('zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader', 'zveltio_ext')
         AND has_table_privilege(r.oid, ${T}::regclass, p)`.execute(db);
    expect(r.rows).toEqual([]);
  });

  it('091 DOWN puts the rows back on the default tenant, under the policy', async () => {
    await runMigration('down');
    expect(await hasColumn('tenant_id')).toBe(true);
    expect((await rls()).forced).toBe(true);
    const tenants = await sql<{ t: string | null }>`
      SELECT DISTINCT tenant_id::text AS t FROM zvd_validation_rule_groups`.execute(db);
    expect(tenants.rows).toEqual([{ t: DEFAULT_TENANT_ID }]);
    await runMigration('up');
    expect(await groups()).toHaveLength(3);
  });
});
