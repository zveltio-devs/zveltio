// packages/engine/src/lib/tenant-manager.ts
// Manages tenant schema lifecycle and resolution

import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getRedis } from './redis.js';

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
  settings: Record<string, any>;
}

const TENANT_CACHE_TTL = 300; // 5 min

let _db: Database;

export function initTenantManager(db: Database): void {
  _db = db;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const redis = getRedis();
  const cacheKey = `tenant:slug:${slug}`;

  if (redis) {
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached);
  }

  const tenant = await (_db as any)
    .selectFrom('zv_tenants')
    .selectAll()
    .where('slug', '=', slug)
    .where('status', '=', 'active')
    .executeTakeFirst();

  if (tenant && redis) {
    await redis.setex(cacheKey, TENANT_CACHE_TTL, JSON.stringify(tenant)).catch(() => {});
  }

  return tenant || null;
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const redis = getRedis();
  const cacheKey = `tenant:id:${id}`;

  if (redis) {
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached);
  }

  const tenant = await (_db as any)
    .selectFrom('zv_tenants')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (tenant && redis) {
    await redis.setex(cacheKey, TENANT_CACHE_TTL, JSON.stringify(tenant)).catch(() => {});
  }

  return tenant || null;
}

export async function getUserTenants(userId: string): Promise<(Tenant & { role: string })[]> {
  return (_db as any)
    .selectFrom('zv_tenant_users as tu')
    .innerJoin('zv_tenants as t', 't.id', 'tu.tenant_id')
    .selectAll('t')
    .select(['tu.role'])
    .where('tu.user_id', '=', userId)
    .where('t.status', '=', 'active')
    .execute();
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
    .onConflict((oc: any) => oc.columns(['tenant_id', 'slug']).doNothing())
    .execute();

  console.log(`✅ Environment '${envSlug}' provisioned for tenant ${tenantSlug} → ${schemaName}`);
}

export async function getTenantEnvironments(tenantId: string): Promise<Environment[]> {
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

  // Priority 2: subdomain
  if (hostname) {
    const parts = hostname.split('.');
    if (parts.length >= 3) {
      const subdomain = parts[0];
      if (subdomain !== 'www' && subdomain !== 'api') {
        return getTenantBySlug(subdomain);
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

  return null;
}

export async function invalidateTenantCache(slug: string, id?: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`tenant:slug:${slug}`).catch(() => {});
  if (id) await redis.del(`tenant:id:${id}`).catch(() => {});
}
