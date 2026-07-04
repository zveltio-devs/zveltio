// packages/engine/src/lib/tenant-manager.ts
// Manages tenant schema lifecycle and resolution

import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getCache } from './cache.js';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan: string;
  status: string;
  max_records: number;
  max_storage_gb: number;
  max_api_calls_day: number;
  max_users: number;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  settings: Record<string, any>;
}

export interface Environment {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  schema_name: string;
  is_production: boolean;
  color: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  settings: Record<string, any>;
}

const TENANT_CACHE_TTL = 300; // 5 min

// The implicit default tenant every install has. Single-tenant deployments
// resolve to it on every request, so the `zveltio.current_tenant` GUC is always
// set and RLS is uniform (single-tenant = "all data belongs to the default
// tenant"). Created by migration 007. Fixed sentinel UUID so it's referenced
// identically by the migration, the collection-table column default, and the
// always-resolve fallback below.
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_TENANT_SLUG = 'default';

const DEFAULT_TENANT: Tenant = {
  id: DEFAULT_TENANT_ID,
  slug: DEFAULT_TENANT_SLUG,
  name: 'Default',
  plan: 'enterprise',
  status: 'active',
  max_records: 2147483647,
  max_storage_gb: 999999,
  max_api_calls_day: 2147483647,
  max_users: 2147483647,
  settings: {},
};

/**
 * The default tenant row (cached). Falls back to the in-memory sentinel if the
 * row isn't present yet (e.g. during the very first boot before migrations) so
 * resolution never returns null.
 */
export async function getDefaultTenant(): Promise<Tenant> {
  return (await getTenantBySlug(DEFAULT_TENANT_SLUG)) ?? DEFAULT_TENANT;
}

const SAFE_COLLECTION_TABLE = /^zvd_[a-z0-9_]+$/i;

/**
 * Apply tenant row isolation to a single collection data table. Idempotent.
 * Ensures the tenant_id column (+ GUC default + NOT NULL, backfilling existing
 * rows to the default tenant) then ENABLE + FORCE RLS with the tenant_isolation
 * policy. Validated against Postgres 18: a non-superuser owner only sees rows of
 * the GUC tenant, cannot forge another tenant's tenant_id (WITH CHECK), and sees
 * zero rows when no GUC is set.
 *
 * IMPORTANT: FORCE RLS is bypassed by SUPERUSER / BYPASSRLS roles. The engine's
 * DB role MUST be a plain non-superuser or isolation is silently ineffective —
 * `warnIfDbRoleBypassesRls` checks this at boot.
 */
export async function applyTenantRLS(db: Database, table: string): Promise<void> {
  if (!SAFE_COLLECTION_TABLE.test(table)) {
    throw new Error(`refusing to apply RLS to unsafe table name: ${table}`);
  }
  const t = `"${table}"`;
  const def = `'${DEFAULT_TENANT_ID}'::uuid`;
  await sql
    .raw(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tenant_id UUID DEFAULT ${def}`)
    .execute(db);
  await sql.raw(`UPDATE ${t} SET tenant_id = ${def} WHERE tenant_id IS NULL`).execute(db);
  await sql
    .raw(
      `ALTER TABLE ${t} ALTER COLUMN tenant_id SET DEFAULT COALESCE(current_setting('zveltio.current_tenant', true)::uuid, ${def})`,
    )
    .execute(db);
  await sql.raw(`ALTER TABLE ${t} ALTER COLUMN tenant_id SET NOT NULL`).execute(db);
  await sql
    .raw(`CREATE INDEX IF NOT EXISTS "idx_${table}_tenant_id" ON ${t}(tenant_id)`)
    .execute(db);
  await sql.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).execute(db);
  await sql.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`).execute(db);
  await sql.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${t}`).execute(db);
  await sql
    .raw(
      `CREATE POLICY tenant_isolation ON ${t} ` +
        `USING (tenant_id::text = current_setting('zveltio.current_tenant', true)) ` +
        `WITH CHECK (tenant_id::text = current_setting('zveltio.current_tenant', true))`,
    )
    .execute(db);
}

/**
 * Boot reconciler: apply tenant isolation to every COLLECTION DATA table.
 * Targets `zvd_<name>` for each row in `zvd_collections` plus the built-in
 * content tables. The `zvd_collections`/`zvd_relations`/`zvd_permissions`
 * metadata tables are global and intentionally excluded (they are not rows in
 * zvd_collections). Best-effort per table — one failure doesn't abort the rest.
 */
export async function reconcileTenantRLS(db: Database): Promise<number> {
  let names: string[];
  try {
    const rows = await sql<{ name: string }>`SELECT name FROM zvd_collections`.execute(db);
    names = rows.rows.map((r) => r.name);
  } catch {
    return 0; // zvd_collections not present yet — nothing to reconcile
  }
  for (const builtin of ['pages', 'views', 'zones']) {
    if (!names.includes(builtin)) names.push(builtin);
  }

  let applied = 0;
  for (const name of names) {
    const table = `zvd_${name}`;
    if (!SAFE_COLLECTION_TABLE.test(table)) continue;
    try {
      const reg = await sql<{ exists: boolean }>`
        SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS exists
      `.execute(db);
      if (!reg.rows[0]?.exists) continue; // collection row without a table yet
      await applyTenantRLS(db, table);
      applied++;
    } catch (err) {
      console.warn(`[tenant-rls] reconcile failed for ${table}:`, (err as Error).message);
    }
  }
  return applied;
}

/**
 * Warn loudly if the engine's DB role can bypass RLS (SUPERUSER or BYPASSRLS).
 * FORCE RLS does NOT bind such roles, so tenant isolation would be silently
 * ineffective. Called once at boot.
 */
export async function warnIfDbRoleBypassesRls(db: Database): Promise<void> {
  try {
    const r = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `.execute(db);
    const row = r.rows[0];
    if (row?.rolsuper || row?.rolbypassrls) {
      console.warn(
        `⚠️  [tenant-rls] The engine DB role "${row.rolname}" is ${
          row.rolsuper ? 'a SUPERUSER' : 'BYPASSRLS'
        } — Postgres row-level security is BYPASSED, so tenant isolation is NOT enforced. ` +
          `Run the engine as a plain (NOSUPERUSER, no BYPASSRLS) role for multi-tenant deployments.`,
      );
    }
  } catch {
    /* non-fatal */
  }
}

// ── Tenant cache HMAC signing ────────────────────────────────────────────────
// Protects cached tenant data against tampering by an attacker with Valkey
// write access (e.g. raising max_records, changing plan, activating a banned
// tenant). Pattern mirrors the god-role cache in permissions.ts.
function _tenantHmac(key: string, value: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set — tenant cache HMAC would use an empty key, providing no integrity protection. Set this environment variable before starting the server.',
    );
  }
  return createHmac('sha256', secret).update(`tenant:${key}:${value}`).digest('hex');
}

function _encodeTenantCache(key: string, data: object): string {
  const json = JSON.stringify(data);
  return `${_tenantHmac(key, json)}:${json}`;
}

function _decodeTenantCache(key: string, raw: string): object | null {
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const storedHmac = raw.slice(0, sep);
  const json = raw.slice(sep + 1);
  try {
    const expected = Buffer.from(_tenantHmac(key, json), 'hex');
    const stored = Buffer.from(storedHmac, 'hex');
    if (stored.length !== expected.length) return null;
    if (!timingSafeEqual(stored, expected)) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}
// ── End HMAC helpers ─────────────────────────────────────────────────────────

let _db: Database;

export function initTenantManager(db: Database): void {
  _db = db;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const cache = getCache();
  const cacheKey = `tenant:slug:${slug}`;

  if (cache) {
    const raw = await cache.get(cacheKey).catch(() => null);
    if (raw) {
      const decoded = _decodeTenantCache(cacheKey, raw);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      if (decoded) return decoded as any;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const tenant = await (_db as any)
    .selectFrom('zv_tenants')
    .selectAll()
    .where('slug', '=', slug)
    .where('status', '=', 'active')
    .executeTakeFirst();

  if (tenant && cache) {
    await cache
      .setex(cacheKey, TENANT_CACHE_TTL, _encodeTenantCache(cacheKey, tenant))
      .catch(() => {});
  }

  return tenant || null;
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const cache = getCache();
  const cacheKey = `tenant:id:${id}`;

  if (cache) {
    const raw = await cache.get(cacheKey).catch(() => null);
    if (raw) {
      const decoded = _decodeTenantCache(cacheKey, raw);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      if (decoded) return decoded as any;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const tenant = await (_db as any)
    .selectFrom('zv_tenants')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (tenant && cache) {
    await cache
      .setex(cacheKey, TENANT_CACHE_TTL, _encodeTenantCache(cacheKey, tenant))
      .catch(() => {});
  }

  return tenant || null;
}

export async function getUserTenants(userId: string): Promise<(Tenant & { role: string })[]> {
  const cache = getCache();
  const cacheKey = `user:tenants:${userId}`;

  if (cache) {
    const raw = await cache.get(cacheKey).catch(() => null);
    if (raw) {
      const decoded = _decodeTenantCache(cacheKey, raw);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      if (decoded) return decoded as any;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const tenants = await (_db as any)
    .selectFrom('zv_tenant_users as tu')
    .innerJoin('zv_tenants as t', 't.id', 'tu.tenant_id')
    .selectAll('t')
    .select(['tu.role'])
    .where('tu.user_id', '=', userId)
    .where('t.status', '=', 'active')
    .execute();

  if (cache) {
    await cache
      .setex(cacheKey, TENANT_CACHE_TTL, _encodeTenantCache(cacheKey, tenants))
      .catch(() => {});
  }

  return tenants;
}

export function getTenantSchemaName(tenantSlug: string): string {
  const safe = tenantSlug.replace(/[^a-z0-9_]/g, '_').toLowerCase();
  return `tenant_${safe}`;
}

/**
 * Create a new PostgreSQL schema for a tenant and initialize system tables.
 * Called when a new tenant is provisioned.
 */
export async function provisionTenantSchema(schemaName: string): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql.id(schemaName)}`.execute(_db);

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.id(schemaName)}.zvd_collections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      singular_name TEXT,
      description TEXT,
      fields JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(_db);

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.id(schemaName)}.zvd_relations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('m2o', 'o2m', 'm2m', 'm2a')),
      source_collection TEXT NOT NULL,
      source_field TEXT NOT NULL,
      target_collection TEXT NOT NULL,
      target_field TEXT,
      junction_table TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source_collection, source_field)
    )
  `.execute(_db);

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.id(schemaName)}.zvd_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ptype TEXT NOT NULL,
      v0 TEXT, v1 TEXT, v2 TEXT, v3 TEXT, v4 TEXT, v5 TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(_db);

  console.log(`✅ Tenant schema provisioned: ${schemaName}`);
}

/**
 * Provision a named environment schema and register it in zv_environments.
 */
export async function provisionEnvironment(
  tenantId: string,
  tenantSlug: string,
  envSlug: string,
  envName: string,
  isProduction: boolean,
): Promise<void> {
  const schemaName = `tenant_${tenantSlug.replace(/[^a-z0-9_]/g, '_').toLowerCase()}_${envSlug}`;

  await provisionTenantSchema(schemaName);

  const colorMap: Record<string, string> = {
    prod: '#dc2626',
    production: '#dc2626',
    staging: '#d97706',
    dev: '#2563eb',
    development: '#2563eb',
  };

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  await (_db as any)
    .insertInto('zv_environments')
    .values({
      tenant_id: tenantId,
      name: envName,
      slug: envSlug,
      schema_name: schemaName,
      is_production: isProduction,
      color: colorMap[envSlug] || '#6b7280',
    })
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    .onConflict((oc: any) => oc.columns(['tenant_id', 'slug']).doNothing())
    .execute();

  console.log(`✅ Environment '${envSlug}' provisioned for tenant ${tenantSlug} → ${schemaName}`);
}

export async function getTenantEnvironments(tenantId: string): Promise<Environment[]> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return (_db as any)
    .selectFrom('zv_environments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('is_production', 'desc')
    .execute();
}

export async function resolveEnvironment(
  tenant: Tenant,
  headers: Headers,
): Promise<Environment | null> {
  const envSlug = headers.get('x-environment') || 'prod';

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const env = await (_db as any)
    .selectFrom('zv_environments')
    .selectAll()
    .where('tenant_id', '=', tenant.id)
    .where('slug', '=', envSlug)
    .executeTakeFirst();

  return env || null;
}

/**
 * Resolve tenant from HTTP request.
 * Priority:
 *   1. X-Tenant-Slug header
 *   2. Subdomain (tenant.yourdomain.com)
 *   3. ZVELTIO_TENANT_ID env var (legacy single-tenant fallback)
 */
export async function resolveTenantFromRequest(
  headers: Headers,
  hostname?: string,
): Promise<Tenant | null> {
  // Priority 1: explicit header
  const headerSlug = headers.get('x-tenant-slug');
  if (headerSlug) return getTenantBySlug(headerSlug);

  // Priority 2: subdomain. NEVER for IP hostnames: "127.0.0.1" splits into 4
  // dot-parts, so it used to be parsed as subdomain "127" → tenant lookup miss →
  // null → the middleware proceeded WITHOUT the tenant GUC and RLS rejected
  // every data write (42501 → 500) and hid every row. Any access by IP —
  // http://127.0.0.1:3000, a LAN address, a fresh demo box — hit this. IPs and
  // bracketed IPv6 have no subdomain semantics; fall through to the default
  // tenant (always-one-tenant) like "localhost" does.
  if (hostname) {
    const isIpV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
    const isIpV6 = hostname.includes(':') || hostname.startsWith('[');
    if (!isIpV4 && !isIpV6) {
      const parts = hostname.split('.');
      if (parts.length >= 3) {
        const subdomain = parts[0];
        if (subdomain !== 'www' && subdomain !== 'api') {
          // Unknown subdomain slug → fall through to the default tenant rather
          // than returning null: null silently disables the tenant GUC, which
          // breaks RLS in the worst possible way (empty reads + 500 writes).
          const bySub = await getTenantBySlug(subdomain);
          if (bySub) return bySub;
        }
      }
    }
  }

  // Priority 3: env var (legacy single-tenant mode)
  const envTenantId = process.env.ZVELTIO_TENANT_ID;
  if (envTenantId) {
    return {
      id: envTenantId,
      slug: envTenantId,
      name: process.env.ZVELTIO_TENANT_NAME || 'Default',
      plan: 'enterprise',
      status: 'active',
      max_records: 2147483647,
      max_storage_gb: 999999,
      max_api_calls_day: 2147483647,
      max_users: 2147483647,
      settings: {},
    };
  }

  // Always-one-tenant: no explicit tenant → the implicit default tenant, so the
  // `zveltio.current_tenant` GUC is always set on data routes and RLS is uniform.
  // Single-tenant installs run entirely as the default tenant.
  return getDefaultTenant();
}

export async function invalidateTenantCache(
  slug: string,
  id?: string,
  userId?: string,
): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  await cache.del(`tenant:slug:${slug}`).catch(() => {});
  if (id) await cache.del(`tenant:id:${id}`).catch(() => {});
  if (userId) await cache.del(`user:tenants:${userId}`).catch(() => {});
}

/**
 * Returns the initialized database instance (used by the tenant middleware to
 * start a per-request transaction for SET LOCAL isolation).
 */
export function getTenantDb(): Database {
  return _db;
}

/**
 * Wraps a callback in a PostgreSQL transaction with SET LOCAL for the tenant GUC.
 * This is the ONLY correct way to ensure RLS isolation in a connection-pool environment:
 * SET LOCAL is scoped to the transaction, so all queries made via `trx` within the
 * callback will see the correct tenant GUC, and the connection is automatically
 * released back to the pool after the transaction commits/rolls back.
 *
 * Usage in route handlers: use `c.get('tenantTrx') || db` for queries.
 */
export async function withTenantIsolation<T>(
  tenantId: string,
  fn: (trx: Database) => Promise<T>,
): Promise<T> {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return (_db as any).transaction().execute(async (trx: Database) => {
    // set_config(..., is_local=true) is the transaction-local equivalent of
    // SET LOCAL but accepts a bind parameter — `SET LOCAL x = $1` is a Postgres
    // syntax error.
    await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

/** @deprecated Use withTenantIsolation() instead. */
export async function setCurrentTenant(_tenantId: string): Promise<void> {
  throw new Error(
    'setCurrentTenant() is deprecated and non-functional. ' +
      'SET LOCAL requires an active transaction. Use withTenantIsolation() instead.',
  );
}

/**
 * Enable PostgreSQL Row-Level Security on a collection table for multi-tenant isolation.
 * Adds a tenant_id column (if missing), creates an index, enables RLS, and installs
 * a tenant_isolation policy that restricts rows to the current tenant session variable.
 *
 * Usage: call once when provisioning a new collection in multi-tenant mode.
 */
export async function enableRLS(tableName: string): Promise<void> {
  // 1. Add tenant_id FK column (idempotent)
  await sql`
    ALTER TABLE ${sql.id(tableName)}
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES zv_tenants(id) ON DELETE CASCADE
  `.execute(_db);

  // 2. Index for query performance
  await sql`
    CREATE INDEX IF NOT EXISTS ${sql.id(`idx_${tableName}_tenant`)}
    ON ${sql.id(tableName)}(tenant_id)
  `.execute(_db);

  // 3. Enable + FORCE RLS.
  //
  //    `ENABLE ROW LEVEL SECURITY` alone leaves a giant escape hatch:
  //    the table OWNER (and anyone with BYPASSRLS) is still exempt
  //    from policies. In Zveltio the engine connects as the owner of
  //    the public schema, so without FORCE, every query the engine
  //    makes effectively sees ALL tenants — RLS becomes advisory.
  //
  //    `FORCE ROW LEVEL SECURITY` removes that escape hatch so even
  //    the owner is bound by the policy. The only way to read across
  //    tenants is then through a connection that explicitly has the
  //    BYPASSRLS attribute (which the engine connection should NOT).
  await sql`ALTER TABLE ${sql.id(tableName)} ENABLE ROW LEVEL SECURITY`.execute(_db);
  await sql`ALTER TABLE ${sql.id(tableName)} FORCE ROW LEVEL SECURITY`.execute(_db);

  // 4. Isolation policy — uses SET LOCAL value from middleware
  //    DROP + CREATE so this function is safe to call multiple times (idempotent)
  await sql`DROP POLICY IF EXISTS tenant_isolation ON ${sql.id(tableName)}`.execute(_db);
  await sql`
    CREATE POLICY tenant_isolation ON ${sql.id(tableName)}
    USING (tenant_id::text = current_setting('zveltio.current_tenant', true))
    WITH CHECK (tenant_id::text = current_setting('zveltio.current_tenant', true))
  `.execute(_db);

  // 5. NULL tenant_id row warning.
  //
  //    enableRLS is typically called AFTER the table already has data.
  //    Existing rows have tenant_id = NULL, and the policy
  //    `tenant_id::text = current_setting(...)` evaluates to NULL
  //    (not true) for them — so they become invisible to every
  //    tenant. Worse, if the operator later disables RLS or BYPASSRLS,
  //    the rows are still there with NULL tenant_id and effectively
  //    leak into any tenant query.
  //
  //    We surface this loudly so the operator runs a backfill UPDATE
  //    before considering the table multi-tenant-safe.
  const orphans = await sql<{ orphan_count: number }>`
    SELECT COUNT(*)::int AS orphan_count FROM ${sql.id(tableName)} WHERE tenant_id IS NULL
  `
    .execute(_db)
    .catch(() => ({ rows: [{ orphan_count: 0 }] }));
  const orphanCount = orphans.rows[0]?.orphan_count ?? 0;
  if (orphanCount > 0) {
    console.warn(
      `[tenant-manager] enableRLS(${tableName}): ${orphanCount} row(s) ` +
        `have tenant_id IS NULL and are now invisible to every tenant. ` +
        `Backfill with: UPDATE ${tableName} SET tenant_id = '<default-tenant-id>' WHERE tenant_id IS NULL`,
    );
  }
}
