/**
 * `zv_validation_rules` is instance-wide schema metadata: collections are shared
 * by every tenant and the rules travel with them (schema export/apply, field
 * rename and drop). Only an instance admin may write one.
 *
 * Measured on master: `developer/validation` gated its writes on
 * `checkPermission(user, 'admin', '*')`, which a tenant admin passes inside
 * their own tenant, and wrote through `ctx.db` — so the admin of one firm
 * stored rules that refused every other firm's writes. Both roles under that
 * write held INSERT, UPDATE and DELETE on the table: `zveltio_rls` (the
 * request role) and the extension's own role.
 *
 * Now the request role and the extension's role only read the table, and the
 * one way to write it is `ctx.internals.writeValidationRule`, which asks the
 * `/ext/*` gate who is calling and writes as the engine for an instance admin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import {
  _resetExtensionDbRoleForTests,
  extensionDbRoleNames,
  grantExtensionDbRole,
} from '../../lib/extensions/ext-db-role.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import {
  DEFAULT_TENANT_ID,
  getCurrentTenantTrx,
  getEnforcer,
  invalidateUserPermCache,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import {
  ALL_COLLECTIONS_ACTOR,
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLL = `vria_${STAMP}`;
const PROBE = `vria-probe-${STAMP}`;
const EXT = 'developer/validation';
const FIRM = { id: crypto.randomUUID(), slug: `vria-${STAMP}` };

d('validation rules are written by an instance admin only', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let godCookie = '';
  let firmAdmin = { cookie: '', userId: '' };

  const rulesOn = async () =>
    (
      await sql<{ id: string; is_active: boolean; created_by: string | null }>`
        SELECT id, is_active, created_by FROM zv_validation_rules WHERE collection = ${COLL}`.execute(
        db,
      )
    ).rows;
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(`/ext/${PROBE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const rule = { collection: COLL, field_name: 'code', rule_type: 'required', error_message: 'x' };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    godCookie = await createGodSession(engine, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${FIRM.id}::uuid, ${FIRM.slug}, 'vria', 'active')`.execute(db);
    // The admin of one firm: `checkPermission(admin, '*')` passes there, which
    // is the gate the extension used.
    const m = await createMemberSession(engine, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${FIRM.id}::uuid, ${m.userId}, 'member')`.execute(db);
    await (await getEnforcer()).addPolicy(m.userId, FIRM.id, 'admin', '*');
    await invalidateUserPermCache(m.userId);
    firmAdmin = m;

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
        sub.post('/rules', async (c) =>
          answer(async () => w(c, { op: 'create', rule: await c.req.json() })),
        );
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
    _resetExtensionDbRoleForTests();
    if (!db) return;
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLL}`.execute(db);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${PROBE}`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${firmAdmin.userId}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${FIRM.id}::uuid`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${firmAdmin.userId}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${FIRM.id}::uuid`.execute(db);
  });

  it('refuses the admin of a firm, and writes nothing', async () => {
    const res = await call(
      'POST',
      '/rules',
      { cookie: firmAdmin.cookie, 'x-tenant-slug': FIRM.slug },
      rule,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { refused: string }).refused).toContain('instance admin');
    expect(await rulesOn()).toEqual([]);
  });

  it('lets an instance admin create, toggle and delete a rule', async () => {
    const god = { cookie: godCookie };
    const created = await call('POST', '/rules', god, rule);
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { row: { id: string } }).row.id;
    expect((await rulesOn()).map((r) => [r.id, r.is_active])).toEqual([[id, true]]);
    expect((await rulesOn())[0]!.created_by).not.toBeNull();

    // The firm admin cannot touch the instance admin's rule either.
    const asFirm = { cookie: firmAdmin.cookie, 'x-tenant-slug': FIRM.slug };
    expect((await call('PATCH', `/rules/${id}`, asFirm, { is_active: false })).status).toBe(403);
    expect((await call('DELETE', `/rules/${id}`, asFirm)).status).toBe(403);
    expect((await rulesOn()).map((r) => r.is_active)).toEqual([true]);

    expect((await call('PATCH', `/rules/${id}`, god, { is_active: false })).status).toBe(200);
    expect((await rulesOn()).map((r) => r.is_active)).toEqual([false]);
    expect((await call('DELETE', `/rules/${id}`, god)).status).toBe(200);
    expect(await rulesOn()).toEqual([]);
  });

  it('refuses a direct write from a tenant transaction (zveltio_rls)', async () => {
    let result = 'ALLOWED';
    try {
      await withTenantIsolation(DEFAULT_TENANT_ID, (trx) =>
        sql`INSERT INTO zv_validation_rules (collection, field_name, rule_type, error_message)
            VALUES (${COLL}, 'code', 'required', 'x')`.execute(trx),
      );
    } catch (err) {
      result = (err as Error).message;
    }
    expect(result).toMatch(/permission denied/i);
    expect(await rulesOn()).toEqual([]);
  });

  it("leaves developer/validation's own role reading the rules and writing none, on an old install too", async () => {
    const allowed = new Set(['zv_validation_rules']);
    _resetExtensionDbRoleForTests();
    await grantExtensionDbRole(db, EXT, allowed);
    const dbName = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(db)).rows[0]!
      .d;
    const { role } = extensionDbRoleNames(dbName, EXT);
    // What every install before this one granted the role.
    await sql`GRANT INSERT, UPDATE, DELETE ON zv_validation_rules TO ${sql.id(role)}`.execute(db);
    await grantExtensionDbRole(db, EXT, allowed);
    const privs = await sql<{ p: string }>`
      SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
       WHERE has_table_privilege(${role}, 'public.zv_validation_rules', p) ORDER BY p`.execute(db);
    expect(privs.rows.map((r) => r.p)).toEqual(['SELECT']);

    const ext = createRestrictedDb(() => getCurrentTenantTrx() ?? db, EXT, allowed);
    const inTenant = <T>(fn: () => Promise<T>) =>
      withTenantIsolation(DEFAULT_TENANT_ID, fn, { identity: ALL_COLLECTIONS_ACTOR });
    await inTenant(() => sql`SELECT count(*) FROM zv_validation_rules`.execute(ext));
    let result = 'ALLOWED';
    try {
      await inTenant(() =>
        sql`INSERT INTO zv_validation_rules (collection, field_name, rule_type, error_message)
            VALUES (${COLL}, 'code', 'required', 'x')`.execute(ext),
      );
    } catch (err) {
      result = (err as Error).message;
    }
    expect(result).toMatch(/permission denied/i);
    expect(await rulesOn()).toEqual([]);
  }, 60_000);
});
