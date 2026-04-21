/**
 * Application-layer Row-Level Security (RLS).
 *
 * Evaluated AFTER Casbin (which grants collection-level access).
 * Injects additional WHERE conditions so users only see records they're
 * entitled to — without touching PostgreSQL's native RLS.
 *
 * Skipped for:
 *   - god users (bypass all policy layers)
 *   - api_key auth (scope-based; no user context for user_id/email filters)
 */

import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getCache } from './cache.js';
import { getUserRoles } from './permissions.js';
import type { FilterCondition } from '../db/dynamic.js';

const RLS_CACHE_TTL = 30; // seconds — short TTL so policy changes apply quickly

export interface RlsPolicy {
  id: string;
  collection: string;
  role: string;
  filter_field: string;
  filter_op: string;
  filter_value_source: string;
  is_enabled: boolean;
  description?: string | null;
}

let _db: Database;

export function initRls(db: Database): void {
  _db = db;
}

/** Resolve a filter_value_source against the current user context. */
function resolveValue(
  source: string,
  user: { id: string; email?: string; role: string },
): string | null {
  if (source === 'user_id') return user.id;
  if (source === 'user_email') return user.email ?? null;
  if (source === 'user_role') return user.role;
  if (source.startsWith('static:')) return source.slice(7);
  return null;
}

/** Load all enabled policies for a collection from DB (with cache). */
async function loadPolicies(collection: string): Promise<RlsPolicy[]> {
  const cache = getCache();
  const cacheKey = `rls:policies:${collection}`;

  if (cache) {
    try {
      const raw = await cache.get(cacheKey);
      if (raw) return JSON.parse(raw) as RlsPolicy[];
    } catch { /* cache unavailable */ }
  }

  const rows = await sql<RlsPolicy>`
    SELECT id, collection, role, filter_field, filter_op, filter_value_source, is_enabled, description
    FROM zvd_rls_policies
    WHERE is_enabled = TRUE
      AND (collection = ${collection} OR collection = '*')
    ORDER BY collection DESC, role
  `.execute(_db);

  const policies = rows.rows;

  if (cache) {
    try {
      await cache.setex(cacheKey, RLS_CACHE_TTL, JSON.stringify(policies));
    } catch { /* cache unavailable */ }
  }

  return policies;
}

/** Invalidate RLS policy cache for a collection (call after policy CRUD). */
export async function invalidateRlsCache(collection: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  try {
    await cache.del(`rls:policies:${collection}`);
    await cache.del('rls:policies:*'); // also clear wildcard collection cache
  } catch { /* cache unavailable */ }
}

/**
 * Returns extra filter conditions to inject into a query for the given user.
 * Returns an empty array when no policies match (no restriction applied).
 *
 * Multiple matching policies are ANDed together (most restrictive wins).
 */
export async function getRlsFilters(
  collection: string,
  user: { id: string; email?: string; role: string },
  authType: 'session' | 'api_key',
): Promise<Array<{ field: string; condition: FilterCondition }>> {
  // god users and API keys bypass RLS
  if (user.role === 'god' || authType === 'api_key') return [];

  const policies = await loadPolicies(collection);
  if (policies.length === 0) return [];

  // Get user's roles from Casbin (includes inherited roles)
  let userRoles: string[];
  try {
    userRoles = await getUserRoles(user.id);
  } catch {
    userRoles = [user.role];
  }
  // Always include the direct role
  if (!userRoles.includes(user.role)) userRoles.push(user.role);

  const result: Array<{ field: string; condition: FilterCondition }> = [];

  for (const policy of policies) {
    // Match if policy role is '*' or user has that role
    const roleMatch = policy.role === '*' || userRoles.includes(policy.role);
    if (!roleMatch) continue;

    const value = resolveValue(policy.filter_value_source, user);
    if (value === null) continue; // can't resolve value — skip (fail-open for this policy)

    const op = (policy.filter_op as FilterCondition['op']) || 'eq';
    result.push({ field: policy.filter_field, condition: { op, value } });
  }

  return result;
}

// ─── Admin CRUD helpers ────────────────────────────────────────────────────────

export async function listRlsPolicies(): Promise<RlsPolicy[]> {
  const rows = await sql<RlsPolicy>`
    SELECT id, collection, role, filter_field, filter_op, filter_value_source, is_enabled, description, created_at, updated_at
    FROM zvd_rls_policies
    ORDER BY collection, role
  `.execute(_db);
  return rows.rows;
}

export async function createRlsPolicy(data: {
  collection: string;
  role: string;
  filter_field: string;
  filter_op: string;
  filter_value_source: string;
  is_enabled?: boolean;
  description?: string;
}): Promise<RlsPolicy> {
  const rows = await sql<RlsPolicy>`
    INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled, description)
    VALUES (
      ${data.collection}, ${data.role}, ${data.filter_field},
      ${data.filter_op}, ${data.filter_value_source},
      ${data.is_enabled ?? true}, ${data.description ?? null}
    )
    RETURNING id, collection, role, filter_field, filter_op, filter_value_source, is_enabled, description
  `.execute(_db);
  await invalidateRlsCache(data.collection);
  return rows.rows[0];
}

export async function updateRlsPolicy(
  id: string,
  data: Partial<Omit<RlsPolicy, 'id'>>,
): Promise<RlsPolicy | null> {
  const rows = await sql<RlsPolicy>`
    UPDATE zvd_rls_policies
    SET
      collection          = COALESCE(${data.collection ?? null}, collection),
      role                = COALESCE(${data.role ?? null}, role),
      filter_field        = COALESCE(${data.filter_field ?? null}, filter_field),
      filter_op           = COALESCE(${data.filter_op ?? null}, filter_op),
      filter_value_source = COALESCE(${data.filter_value_source ?? null}, filter_value_source),
      is_enabled          = COALESCE(${data.is_enabled ?? null}, is_enabled),
      description         = COALESCE(${data.description ?? null}, description),
      updated_at          = NOW()
    WHERE id = ${id}
    RETURNING id, collection, role, filter_field, filter_op, filter_value_source, is_enabled, description
  `.execute(_db);
  if (rows.rows[0]) await invalidateRlsCache(rows.rows[0].collection);
  return rows.rows[0] ?? null;
}

export async function deleteRlsPolicy(id: string): Promise<boolean> {
  const rows = await sql<{ collection: string }>`
    DELETE FROM zvd_rls_policies WHERE id = ${id} RETURNING collection
  `.execute(_db);
  if (rows.rows[0]) await invalidateRlsCache(rows.rows[0].collection);
  return rows.rows.length > 0;
}
