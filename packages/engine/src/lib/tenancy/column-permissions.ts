import type { Database } from '../../db/index.js';
import { getCache } from '../runtime/index.js';
import { checkPermission } from './permissions.js';
import { decodeSigned, encodeSigned } from './signed-cache.js';

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

/**
 * The permission that exempts an identity from column-level restrictions.
 *
 * Free-form, like every other action reaching `checkPermission` — actions are
 * not enumerated anywhere; a policy row grants one. `data:view_all` is the
 * row-level equivalent used by `getRlsFilters`, and this is deliberately NOT
 * that one: seeing every row and seeing every column are different powers, and
 * an operator who grants one should not silently grant the other.
 */
const VIEW_ALL_COLUMNS = 'view_all_columns';

export async function getColumnAccess(
  db: Database,
  collection: string,
  role: string,
  /**
   * Who is asking. Required for the exemption — without it there is none, which
   * is the refusing direction. Optional in the signature because
   * `lib/extensions/internals.ts` exposes this to extensions and an older
   * caller must not silently gain an exemption it never asked for.
   */
  userId?: string,
): Promise<ColumnAccess> {
  // The exemption is a PERMISSION, resolved for an identity — not a role name.
  //
  // This used to read `role === 'admin' || role === 'superadmin'`, and both
  // halves were wrong. `resolveUserRole` returns `SELECT role FROM "user"`, so
  // the value was the INSTANCE role, whose CHECK constraint
  // (001_initial.sql:1160) permits exactly `god | admin | manager | member`.
  // Measured against all four:
  //
  //   member  masked      manager  masked
  //   admin   NOT masked  god      MASKED
  //
  // The exemption went to a role that is not the most privileged one; the one
  // role the instance does treat as privileged was the one being restricted;
  // and `superadmin` is not assignable at all, so half the condition could
  // never fire. A column rule configured against an instance admin was
  // accepted, stored, and silently never applied.
  //
  // Restoring the intent as `role === 'god'` would have repeated the mistake in
  // a tidier spelling. `lib/tenancy/rls.ts` met the same shape and says why a
  // name is the wrong mechanism: "a string comparison against a role name is
  // invisible, unauditable and impossible to revoke."
  //
  // So god passes THROUGH the permission system rather than around it —
  // `checkPermission` returns true for a god user before consulting any policy,
  // which is where "god can do anything" is expressed once for the whole
  // engine. Everything else is deny-by-default, so today god is the only
  // identity exempt, and an operator can grant `data:view_all_columns` to a
  // named role deliberately, or revoke it, and see it in the policy table.
  //
  // Checked before the cache on purpose: the cache is keyed by collection and
  // role, and an exemption is a property of the identity.
  if (userId) {
    if (await checkPermission(userId, 'data', VIEW_ALL_COLUMNS).catch(() => false)) {
      return { hidden: new Set(), readOnly: new Set() };
    }
  }

  const cache = getCache();
  const key = cacheKey(collection, role);

  if (cache) {
    try {
      const cached = await cache.get(key);
      // Signed: this cache decides which columns a role may see, so anyone who
      // can write the key can un-hide all of them. A tampered entry decodes to
      // null and we fall through to the database.
      if (cached) {
        const parsed = decodeSigned<{ hidden: string[]; readOnly: string[] }>(
          'colperms',
          key,
          cached,
        );
        if (parsed) return { hidden: new Set(parsed.hidden), readOnly: new Set(parsed.readOnly) };
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
        encodeSigned('colperms', key, { hidden: [...hidden], readOnly: [...readOnly] }),
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
    const { invalidateQueryCacheForCollection } = await import('../data/index.js');
    await invalidateQueryCacheForCollection(collection);
  }
}

export function applyColumnAccess(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  record: Record<string, any>,
  access: ColumnAccess,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
): Record<string, any> {
  if (access.hidden.size === 0) return record;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!access.hidden.has(k) && !access.hidden.has('*')) {
      result[k] = v;
    }
  }
  return result;
}

export function filterWritableFields(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  data: Record<string, any>,
  access: ColumnAccess,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
): { data: Record<string, any>; blocked: string[] } {
  // A column the user cannot see must not be writable either — writing it
  // blind lets a role set values it can never read back, which defeats the
  // purpose of hiding it. Treat hidden as implicitly read-only.
  const hasMask =
    access.readOnly.size > 0 ||
    access.readOnly.has('*') ||
    access.hidden.size > 0 ||
    access.hidden.has('*');
  if (!hasMask) {
    return { data, blocked: [] };
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  const result: Record<string, any> = {};
  const blocked: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (
      access.readOnly.has(k) ||
      access.readOnly.has('*') ||
      access.hidden.has(k) ||
      access.hidden.has('*')
    ) {
      blocked.push(k);
    } else {
      result[k] = v;
    }
  }
  return { data: result, blocked };
}
