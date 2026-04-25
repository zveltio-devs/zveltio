import type { Database } from '../db/index.js';
import { getCache } from './cache.js';

export interface ColumnAccess {
  /** Columns the user cannot see (filtered from GET responses) */
  hidden: Set<string>;
  /** Columns the user can see but cannot modify */
  readOnly: Set<string>;
}

const CACHE_TTL = 60; // seconds

function cacheKey(collection: string, role: string) {
  return `colperms:${collection}:${role}`;
}

export async function getColumnAccess(
  db: Database,
  collection: string,
  role: string,
): Promise<ColumnAccess> {
  // Admins have full access
  if (role === 'admin' || role === 'superadmin') {
    return { hidden: new Set(), readOnly: new Set() };
  }

  const cache = getCache();
  const key = cacheKey(collection, role);

  if (cache) {
    try {
      const cached = await cache.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as { hidden: string[]; readOnly: string[] };
        return { hidden: new Set(parsed.hidden), readOnly: new Set(parsed.readOnly) };
      }
    } catch { /* cache miss */ }
  }

  const rows = await (db as any)
    .selectFrom('zvd_column_permissions')
    .select(['column_name', 'can_read', 'can_write'])
    .where('collection_name', '=', collection)
    .where('role', 'in', [role, '*'])
    .execute();

  const hidden = new Set<string>();
  const readOnly = new Set<string>();

  for (const row of rows as { column_name: string; can_read: boolean; can_write: boolean }[]) {
    if (!row.can_read) hidden.add(row.column_name);
    else if (!row.can_write) readOnly.add(row.column_name);
  }

  if (cache) {
    try {
      await cache.setex(key, CACHE_TTL, JSON.stringify({
        hidden: [...hidden],
        readOnly: [...readOnly],
      }));
    } catch { /* non-critical */ }
  }

  return { hidden, readOnly };
}

export function invalidateColumnPermCache(collection?: string) {
  const cache = getCache();
  if (!cache) return;
  if (collection) {
    // Can't delete by pattern without SCAN — just let TTL expire
  } else {
    // On full invalidation, callers should pass collection to be precise
  }
}

export function applyColumnAccess(record: Record<string, any>, access: ColumnAccess): Record<string, any> {
  if (access.hidden.size === 0) return record;
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!access.hidden.has(k) && !access.hidden.has('*')) {
      result[k] = v;
    }
  }
  return result;
}

export function filterWritableFields(
  data: Record<string, any>,
  access: ColumnAccess,
): { data: Record<string, any>; blocked: string[] } {
  if (access.readOnly.size === 0 && !access.readOnly.has('*')) {
    return { data, blocked: [] };
  }
  const result: Record<string, any> = {};
  const blocked: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (access.readOnly.has(k) || access.readOnly.has('*')) {
      blocked.push(k);
    } else {
      result[k] = v;
    }
  }
  return { data: result, blocked };
}
