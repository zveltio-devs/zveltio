/**
 * `zv_environments` is isolated by Postgres, not only by its three readers.
 *
 * The table carries `tenant_id` and had no policy, declared "unpoliced" on the
 * belief that the environment is resolved before the tenant is known. It is not:
 * `tenantMiddleware` looks it up after resolving the tenant, by the tenant's id.
 * Migration 029 puts the table under the tenant policy.
 *
 * All three readers ran on the pool, and on a non-superuser database a policed
 * table read there answers for the default firm only. The harness pool is a
 * superuser, where no policy binds, so the tenant manager is pointed here at a
 * pool whose every connection is `zveltio_rls` — what a correctly provisioned
 * install connects as.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { Kysely, sql } from 'kysely';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import type { Database } from '../../db/index.js';
import type { DbSchema } from '../../db/schema.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { initTenantManager, withTenantIsolation } from '../../lib/tenancy/index.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `envrls-${OTHER.slice(0, 8)}`;
const STAMP = `envrls_${Date.now()}`;
const FN = 'harness_environments_rls_rows';

/** The harness URL, every connection opened as the plain role. */
function plainRoleUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', '-c role=zveltio_rls');
  return url.toString();
}

d('zv_environments under tenant RLS', () => {
  let app: Hono;
  let db: Database;
  let plain: Database;
  let god = '';
  const raw: Record<string, string> = {};

  const headers = (tenant: string, extra: Record<string, string>) => ({
    'Content-Type': 'application/json',
    ...extra,
    ...(tenant === OTHER ? { 'X-Tenant-Slug': SLUG } : {}),
  });

  /** Run `fn` with the tenant manager on the plain-role pool. */
  async function onPlainPool<T>(fn: () => Promise<T>): Promise<T> {
    initTenantManager(plain);
    try {
      return await fn();
    } finally {
      initTenantManager(db);
    }
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    plain = new Kysely<DbSchema>({
      dialect: new BunSqlDialect({ connectionString: plainRoleUrl(), max: 4 }),
    }) as unknown as Database;
    const { userId } = await createMemberSession(app, db);
    god = await createGodSession(app, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    // A tenant key acts on its issuer's membership there.
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${OTHER}::uuid, ${userId}, 'member')`.execute(db);
    for (const tenant of [ROOT, OTHER]) {
      await sql`INSERT INTO zv_environments (tenant_id, name, slug, schema_name)
                VALUES (${tenant}::uuid, ${STAMP}, ${STAMP}, ${`${STAMP}_${tenant.slice(0, 8)}`})`.execute(
        db,
      );
      raw[tenant] = generateApiKey();
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
        VALUES (${`${STAMP}-${tenant}`}, ${await hashApiKey(raw[tenant]!)}, ${raw[tenant]!.slice(0, 12)},
                ${JSON.stringify([{ collection: '$rpc', actions: ['execute'] }])}::jsonb, true,
                ${tenant}::uuid, ${userId})`.execute(db);
    }
    // No tenant predicate anywhere in it: whatever it returns, the policy chose.
    await sql
      .raw(`CREATE OR REPLACE FUNCTION "${FN}"() RETURNS TABLE(tenant_id uuid)
            LANGUAGE sql STABLE AS $$
              SELECT tenant_id FROM zv_environments WHERE slug = '${STAMP}'
            $$`)
      .execute(db);
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`.execute(db);
    await sql`INSERT INTO zvd_rpc_functions (function_name, required_role, is_enabled)
              VALUES (${FN}, 'member', true)`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (db) initTenantManager(db);
    await plain?.destroy().catch(() => undefined);
    if (!db) return;
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`.execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS "${FN}"()`).execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
    const schemas = await sql<{ s: string }>`
      SELECT schema_name AS s FROM zv_environments WHERE tenant_id = ${OTHER}::uuid`.execute(db);
    for (const { s } of schemas.rows) {
      if (s.startsWith('tenant_'))
        await sql.raw(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).execute(db);
    }
    await sql`DELETE FROM zv_environments WHERE slug = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${OTHER}::uuid`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('a reader with no tenant filter sees only its own firm’s environments', async () => {
    for (const tenant of [OTHER, ROOT]) {
      const res = await app.request(`/api/rpc/${FN}`, {
        method: 'POST',
        headers: headers(tenant, { 'X-API-Key': raw[tenant]! }),
        body: '{}',
      });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { tenant_id: string }[] };
      expect(data.map((r) => r.tenant_id)).toEqual([tenant]);
    }
  });

  it('the middleware resolves a non-default firm’s environment on a plain-role pool', async () => {
    // The real middleware; nothing core reads `environment` back, so a probe does.
    const probe = new Hono();
    probe.use('*', tenantMiddleware);
    probe.get('*', (c) =>
      c.json({
        env: c.get('environment')?.slug ?? null,
        schema: c.get('environment')?.schema_name,
      }),
    );
    // Counts the transactions the middleware opens. Methods are bound to the
    // real instance: Kysely keeps its state in private fields a proxy cannot reach.
    let txns = 0;
    const counted = new Proxy(plain, {
      get(target, prop) {
        if (prop === 'transaction') txns++;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const request = async (path: string) => {
      txns = 0;
      initTenantManager(counted);
      try {
        const res = await probe.request(path, {
          headers: headers(OTHER, { 'X-Environment': STAMP }),
        });
        expect(res.status).toBe(200);
        return { body: await res.json(), txns };
      } finally {
        initTenantManager(db);
      }
    };

    // In the request transaction: resolved as the tenant, in that one transaction.
    expect(await request('/api/probe')).toEqual({
      body: { env: STAMP, schema: `${STAMP}_${OTHER.slice(0, 8)}` },
      txns: 1,
    });
    // On a TXN_SKIP_PREFIXES path nothing reads it, so it is not looked up at
    // all: no transaction opened just to answer a question nobody asks.
    for (const path of ['/api/health', '/api/tenants/probe']) {
      expect(await request(path)).toEqual({ body: { env: null }, txns: 0 });
    }
  });

  it('/api/tenants lists and creates a non-default firm’s environments', async () => {
    const list = async () => {
      const res = await onPlainPool(async () =>
        app.request(`/api/tenants/${OTHER}/environments`, {
          headers: headers(OTHER, { cookie: god }),
        }),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { environments: { slug: string }[] }).environments.map(
        (e) => e.slug,
      );
    };
    expect(await list()).toEqual([STAMP]);

    // The schema DDL needs the owner, so this runs on the harness pool; the
    // row itself is written as the firm, where WITH CHECK binds.
    const create = await app.request(`/api/tenants/${OTHER}/environments`, {
      method: 'POST',
      headers: headers(OTHER, { cookie: god }),
      body: JSON.stringify({ slug: 'staging', name: 'Staging' }),
    });
    expect(create.status).toBe(201);
    expect((await list()).sort()).toEqual([STAMP, 'staging'].sort());
  }, 30_000);

  it('a firm cannot write an environment into another firm', async () => {
    const write = withTenantIsolation(OTHER, (trx) =>
      sql`INSERT INTO zv_environments (tenant_id, name, slug, schema_name)
          VALUES (${ROOT}::uuid, 'x', ${`${STAMP}-x`}, 'x')`.execute(trx),
    );
    await expect(write).rejects.toThrow(/row-level security/);
  });
});
