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
    } catch {
      /* cache miss */
    }
  }

  const rows = await db
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
      await cache.setex(
        key,
        CACHE_TTL,
        JSON.stringify({
          hidden: [...hidden],
          readOnly: [...readOnly],
        }),
      );
    } catch {
      /* non-critical */
    }
  }

  return { hidden, readOnly };
}

export async function invalidateColumnPermCache(collection?: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  // Column access is cached as `colperms:<collection>:<role>`. SCAN + delete the
  // matching keys (scoped to the collection when given, else all), then drop the
  // query cache for the collection — it stores already-column-masked rows, so a
  // column-permission change must invalidate both or it's served stale.
  try {
    const pattern = collection ? `colperms:${collection}:*` : 'colperms:*';
    let cursor = '0';
    const keys: string[] = [];
    do {
      const [next, batch] = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length > 0) await cache.del(...keys);
  } catch {
    /* cache unavailable */
  }
  if (collection) {
    const { invalidateQueryCacheForCollection } = await import('./query-cache.js');
    await invalidateQueryCacheForCollection(collection);
  }
}

export function applyColumnAccess(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  record: Record<string, any>,
  access: ColumnAccess,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
): Record<string, any> {
  if (access.hidden.size === 0) return record;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!access.hidden.has(k) && !access.hidden.has('*')) {
      result[k] = v;
    }
  }
  return result;
}

export function filterWritableFields(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  data: Record<string, any>,
  access: ColumnAccess,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
): { data: Record<string, any>; blocked: string[] } {
  if (access.readOnly.size === 0 && !access.readOnly.has('*')) {
    return { data, blocked: [] };
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
