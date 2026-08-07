// packages/engine/src/lib/tenant-manager.ts
// Manages tenant schema lifecycle and resolution

import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getCache } from '../runtime/index.js';
import { runWithTenantTrx } from './tenant-context.js';

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
/** Engine (`zv_`) and collection (`zvd_`) tables alike — used by the extension reconciler. */
const SAFE_TENANT_TABLE = /^zvd?_[a-z0-9_]+$/i;
/** Policy names come from pg_policies, but they are interpolated into DDL. */
const SAFE_POLICY_NAME = /^[a-z0-9_]+$/i;

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
  // NULLIF(..., '') is load-bearing: current_setting(..., true) returns an EMPTY
  // STRING (not NULL) when the GUC is set-but-blank — e.g. a god/single-tenant
  // request that runs without a tenant context. COALESCE only catches NULL, so
  // without the NULLIF the default evaluates `''::uuid` → "invalid input syntax
  // for type uuid" and every insert into an RLS table 500s. NULLIF maps '' → NULL
  // so COALESCE falls back to the default tenant.
  await sql
    .raw(
      `ALTER TABLE ${t} ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, ${def})`,
    )
    .execute(db);
  await sql.raw(`ALTER TABLE ${t} ALTER COLUMN tenant_id SET NOT NULL`).execute(db);
  await sql
    .raw(`CREATE INDEX IF NOT EXISTS "idx_${table}_tenant_id" ON ${t}(tenant_id)`)
    .execute(db);
  await sql.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).execute(db);
  await sql.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`).execute(db);
  await sql.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${t}`).execute(db);
  // The predicate lives in `zveltio_tenant_scope_ok` (migration 029) rather than
  // being spelled out here. It used to be written inline, and the extension
  // migration template wrote its own fail-OPEN version of the same rule — two
  // spellings that behaved oppositely when a query arrived with no tenant
  // context. Naming it once is what makes that impossible to repeat.
  await sql
    .raw(
      `CREATE POLICY tenant_isolation ON ${t} ` +
        `USING (zveltio_tenant_scope_ok(tenant_id)) ` +
        `WITH CHECK (zveltio_tenant_scope_ok(tenant_id))`,
    )
    .execute(db);
}

/**
 * Boot reconciler: put every extension-owned tenant table on the host's
 * predicate.
 *
 * Extensions install their own isolation from a copied `002_tenant_rls.sql`,
 * and all 54 copies were fail-open: no tenant context meant every tenant's
 * rows, where the engine's own tables meant none. Rewriting them here rather
 * than patching 54 files makes tenant isolation something the host guarantees
 * instead of something each extension author gets right — including extensions
 * that are not in this repository and cannot be edited from it.
 *
 * Targets exactly the tables that already declared a `tenant_isolation_*`
 * policy, so this adopts an extension's stated intent and never invents
 * isolation for a table that deliberately has none (catalogues, lookup data).
 *
 * Best-effort per table: one failure must not stop the engine from booting.
 */
export async function reconcileExtensionTenantRLS(db: Database): Promise<number> {
  let targets: { tablename: string; policyname: string }[];
  try {
    const rows = await sql<{ tablename: string; policyname: string }>`
      SELECT tablename, policyname
        FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname LIKE 'tenant\\_isolation\\_%'
    `.execute(db);
    targets = rows.rows;
  } catch {
    return 0;
  }

  let applied = 0;
  for (const { tablename, policyname } of targets) {
    // Extension tables are `zv_*` (their own namespace) or `zvd_*` (collection
    // data) — SAFE_COLLECTION_TABLE only matches the latter, so it would have
    // skipped every extension table this function exists to fix.
    if (!SAFE_TENANT_TABLE.test(tablename) || !SAFE_POLICY_NAME.test(policyname)) continue;
    const t = `"${tablename}"`;
    const def = `'${DEFAULT_TENANT_ID}'::uuid`;
    try {
      // Backfill before switching the predicate. The old policy made a NULL
      // tenant_id visible to everyone; the new one makes it visible to nobody.
      // Without this the fix would read as data loss — the rows are simply
      // pre-tenant rows, and they belong to the default tenant, which is what
      // migration 007 already decided for the engine's own tables.
      const orphans = await sql<{ n: number }>`
        SELECT COUNT(*)::int AS n FROM ${sql.id(tablename)} WHERE tenant_id IS NULL
      `.execute(db);
      const n = orphans.rows[0]?.n ?? 0;
      if (n > 0) {
        await sql.raw(`UPDATE ${t} SET tenant_id = ${def} WHERE tenant_id IS NULL`).execute(db);
        console.warn(
          `[tenant-rls] ${tablename}: backfilled ${n} row(s) with no tenant_id to the ` +
            `default tenant — they were previously visible to every tenant.`,
        );
      }
      // Match the engine's column DEFAULT so writes and reads agree.
      await sql
        .raw(
          `ALTER TABLE ${t} ALTER COLUMN tenant_id SET DEFAULT ` +
            `COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, ${def})`,
        )
        .execute(db);
      await sql.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).execute(db);
      await sql.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`).execute(db);
      await sql.raw(`DROP POLICY IF EXISTS ${`"${policyname}"`} ON ${t}`).execute(db);
      await sql
        .raw(
          `CREATE POLICY ${`"${policyname}"`} ON ${t} ` +
            `USING (zveltio_tenant_scope_ok(tenant_id)) ` +
            `WITH CHECK (zveltio_tenant_scope_ok(tenant_id))`,
        )
        .execute(db);
      applied++;
    } catch (err) {
      console.warn(
        `[tenant-rls] extension reconcile failed for ${tablename}:`,
        (err as Error).message,
      );
    }
  }
  return applied;
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
    // Drop to a role Postgres will actually apply RLS to.
    //
    // `docker-compose.yml` passes POSTGRES_USER to the official Postgres image,
    // which creates it as a SUPERUSER — and FORCE ROW LEVEL SECURITY does not
    // bind superusers. So on a stock install every isolation policy in this
    // codebase was advisory, and the boot warning about it scrolled past in the
    // startup log. Rather than depending on how the operator configured their
    // database, the engine spends each tenant transaction as a plain role; the
    // role reverts when the transaction ends.
    //
    // Only DATA access is downgraded. Schema-management routes do not open this
    // transaction at all (TXN_SKIP_PREFIXES), so DDL keeps the owner's rights.
    //
    // Skipped when the role is absent — a managed Postgres may not have let
    // migration 030 create it, and the engine has to keep working there.
    if (_rlsRoleAvailable) {
      await sql.raw('SET LOCAL ROLE zveltio_rls').execute(trx);
    }

    // set_config(..., is_local=true) is the transaction-local equivalent of
    // SET LOCAL but accepts a bind parameter — `SET LOCAL x = $1` is a Postgres
    // syntax error.
    await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
    // Bind the transaction to the async context as well as handing it to `fn`.
    //
    // `ctx.db` given to extensions is a proxy that resolves
    // `getCurrentTenantTrx()` per query, which is what makes a plain `db` in an
    // extension route tenant-scoped without threading anything. Background work
    // opened its transaction here and did NOT set that store, so inside a job
    // `ctx.db` still fell through to the global pool — the one place the
    // guarantee quietly did not hold, and the reason `data/export` had to be
    // handed its transaction explicitly.
    //
    // Setting it here means there is ONE spelling that is correct everywhere:
    // in a handler, in a helper called from one, and in a job.
    return runWithTenantTrx(trx, tenantId, () => fn(trx));
  });
}

/**
 * Whether `SET LOCAL ROLE zveltio_rls` will work on this database.
 *
 * Resolved once at boot rather than probed per request: the answer cannot
 * change while the process runs, and a failed SET aborts the surrounding
 * transaction, so discovering it lazily would break the first request instead
 * of logging a line at startup.
 */
let _rlsRoleAvailable = false;

/**
 * Recreate `zveltio_rls` if it is not here, before deciding whether it is.
 *
 * Migration 030 creates the role, and a migration runs once. `zveltio_rls` is a
 * CLUSTER object, so `pg_dump` does not carry it — and the ledger of applied
 * migrations IS in the dump. Restore a backup onto new hardware and you get
 * every table, every policy, and a `zv_migrations` row saying 030 already ran,
 * on a server where the role has never existed and never will.
 *
 * What happens next is quiet rather than loud. The policies restore fine, since
 * they name a function and not a role. The `GRANT … TO zveltio_rls` statements
 * in the dump fail, the restore continues past them, and at boot the engine
 * finds no role, falls back to connecting as itself, and — if that connection
 * is a superuser, which it is on a default install — RLS does not apply to it.
 * There is a warning in the log. It is competing for attention with a disaster.
 *
 * So the role is provisioned here, at every boot, rather than once in a
 * migration. Idempotent and identical to what 030 does; on a healthy instance
 * it grants what is already granted and returns.
 *
 * Best-effort by design: a managed Postgres where the engine's user cannot
 * create roles is a legitimate deployment, and it should keep starting and keep
 * warning, exactly as it does now. Failing here would turn a degraded restore
 * into no restore at all.
 */
async function ensureRlsEnforcementRole(db: Database): Promise<void> {
  try {
    await sql`
      DO $ensure_rls$
      DECLARE t record; s record;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zveltio_rls') THEN
          CREATE ROLE zveltio_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
        EXECUTE format('GRANT zveltio_rls TO %I', current_user);
        GRANT USAGE ON SCHEMA public TO zveltio_rls;
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO zveltio_rls', t.tablename);
        END LOOP;
        FOR s IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
          EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO zveltio_rls', s.sequencename);
        END LOOP;
      END
      $ensure_rls$;
    `.execute(db);
  } catch (err) {
    // Not fatal, and not silent either: the caller logs the resulting mode, and
    // `warnIfDbRoleBypassesRls` says plainly what it costs.
    console.warn(
      '[tenant-rls] could not provision the zveltio_rls role (continuing):',
      (err as Error).message,
    );
  }
}

/** Boot check — see `_rlsRoleAvailable`. Returns the mode for logging. */
export async function initRlsEnforcementRole(
  db: Database,
): Promise<'enforced' | 'native' | 'unavailable'> {
  await ensureRlsEnforcementRole(db);
  try {
    const r = await sql<{ ok: boolean; super_user: boolean }>`
      SELECT pg_has_role(current_user, 'zveltio_rls', 'MEMBER') AS ok,
             (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
               AS super_user
    `.execute(db);
    const row = r.rows[0];
    _rlsRoleAvailable = Boolean(row?.ok);
    if (_rlsRoleAvailable) return 'enforced';
    // No role, but the connection is already a plain one — RLS binds it
    // directly and there is nothing to fix.
    return row?.super_user ? 'unavailable' : 'native';
  } catch {
    // The role does not exist (migration 030 could not create it).
    _rlsRoleAvailable = false;
    return 'unavailable';
  }
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
