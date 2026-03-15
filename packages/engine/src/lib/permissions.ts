import { createHmac, timingSafeEqual } from 'crypto';
import { newEnforcer, type Enforcer } from 'casbin';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getCache } from './cache.js';

// Cache TTLs
const PERMISSION_CACHE_TTL = 60;  // seconds
const ROLE_CACHE_TTL       = 300; // seconds
const GOD_CACHE_TTL        = 300; // seconds

const CASBIN_MODEL = `
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub) && (r.obj == p.obj || p.obj == '*') && (r.act == p.act || p.act == '*')
`;

let _db: Database;
let _enforcer: Enforcer | null = null;

// O(log N) cu SCAN vs O(N) blocant cu KEYS
async function scanKeys(cache: Awaited<ReturnType<typeof getCache>>, pattern: string): Promise<string[]> {
  if (!cache) return [];
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

class KyselyCasbinAdapter {
  async loadPolicy(model: any): Promise<void> {
    const policies = await sql<{
      ptype: string;
      v0: string | null;
      v1: string | null;
      v2: string | null;
      v3: string | null;
      v4: string | null;
      v5: string | null;
    }>`
      SELECT ptype, v0, v1, v2, v3, v4, v5
      FROM zvd_permissions
    `.execute(_db);

    for (const line of policies.rows) {
      const tokens = [
        line.ptype,
        line.v0,
        line.v1,
        line.v2,
        line.v3,
        line.v4,
        line.v5,
      ].filter((v): v is string => v !== null);
      model.addPolicy(tokens);
    }
  }

  async savePolicy(model: any): Promise<boolean> {
    await sql`DELETE FROM zvd_permissions`.execute(_db);
    const policies = model.getPolicy();
    for (const policy of policies) {
      const [ptype, ...values] = policy;
      await sql`
        INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3, v4, v5)
        VALUES (${ptype}, ${values[0] ?? null}, ${values[1] ?? null}, ${values[2] ?? null},
                ${values[3] ?? null}, ${values[4] ?? null}, ${values[5] ?? null})
      `.execute(_db);
    }
    return true;
  }

  async addPolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3, v4, v5)
      VALUES (${ptype}, ${rule[0] ?? null}, ${rule[1] ?? null}, ${rule[2] ?? null},
              ${rule[3] ?? null}, ${rule[4] ?? null}, ${rule[5] ?? null})
    `.execute(_db);
  }

  async removePolicy(
    _sec: string,
    ptype: string,
    rule: string[],
  ): Promise<void> {
    await sql`
      DELETE FROM zvd_permissions
      WHERE ptype = ${ptype} AND v0 = ${rule[0] ?? null} AND v1 = ${rule[1] ?? null} AND v2 = ${rule[2] ?? null}
    `.execute(_db);
  }

  async removeFilteredPolicy(
    _sec: string,
    ptype: string,
    _fieldIndex: number,
    ...fieldValues: (string | undefined)[]
  ): Promise<void> {
    const conditions: any[] = [sql`ptype = ${ptype}`];
    if (fieldValues[0] !== undefined)
      conditions.push(sql`v0 = ${fieldValues[0]}`);
    if (fieldValues[1] !== undefined)
      conditions.push(sql`v1 = ${fieldValues[1]}`);
    if (fieldValues[2] !== undefined)
      conditions.push(sql`v2 = ${fieldValues[2]}`);

    await sql`DELETE FROM zvd_permissions WHERE ${sql.join(conditions, sql` AND `)}`.execute(
      _db,
    );
  }
}

export async function initPermissions(db: Database): Promise<void> {
  _db = db;
  _enforcer = await newEnforcer(CASBIN_MODEL, new KyselyCasbinAdapter());
}

export async function getEnforcer(): Promise<Enforcer> {
  if (!_enforcer)
    throw new Error(
      'Permissions not initialized. Call initPermissions() first.',
    );
  return _enforcer;
}

/**
 * HMAC helpers for the god-role cache.
 *
 * Threat model: an attacker who can write arbitrary keys into Valkey could
 * set `god:{userId}` to `'1'` and bypass all authorization.  Signing the
 * cached value with HMAC-SHA256 (keyed on BETTER_AUTH_SECRET) makes the
 * value unforgeable without knowledge of the application secret.
 *
 * Format stored in cache: `${value}:${hmac}` e.g. `1:a3f9...`
 * If HMAC verification fails, we return `null` → DB fallback (fail-closed).
 */
function _godHmac(userId: string, value: '1' | '0'): string {
  const secret = process.env.BETTER_AUTH_SECRET ?? '';
  return createHmac('sha256', secret)
    .update(`god:${userId}:${value}`)
    .digest('hex');
}

function _encodeGodCache(userId: string, isGod: boolean): string {
  const value = isGod ? '1' : '0';
  return `${value}:${_godHmac(userId, value)}`;
}

/** Returns `true/false` if HMAC is valid, `null` if tampered / invalid format. */
function _decodeGodCache(userId: string, raw: string): boolean | null {
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const value = raw.slice(0, sep);
  const storedHmac = raw.slice(sep + 1);
  if (value !== '1' && value !== '0') return null;
  try {
    const expected = Buffer.from(_godHmac(userId, value as '1' | '0'), 'hex');
    const stored   = Buffer.from(storedHmac, 'hex');
    if (stored.length !== expected.length) return null;
    if (!timingSafeEqual(stored, expected)) return null;
  } catch {
    return null;
  }
  return value === '1';
}

/**
 * Checks if a user has the "god" role — directly from DB, independent of Casbin.
 * Cached for performance. Fail-closed: returns false if DB is unavailable.
 * Cache values are HMAC-signed to prevent Valkey-injection privilege escalation.
 */
async function isGodUser(userId: string): Promise<boolean> {
  const cache = getCache();
  const cacheKey = `god:${userId}`;

  if (cache) {
    try {
      // GET — O(1): single key lookup by exact name, no scan.
      const raw = await cache.get(cacheKey);
      if (raw !== null) {
        const decoded = _decodeGodCache(userId, raw);
        // null = HMAC mismatch → fall through to DB (do not trust cached value)
        if (decoded !== null) return decoded;
      }
    } catch {
      /* cache unavailable */
    }
  }

  try {
    const result = await sql<{ role: string }>`
      SELECT role FROM "user" WHERE id = ${userId} LIMIT 1
    `.execute(_db);

    const isGod = result.rows[0]?.role === 'god';

    if (cache) {
      try {
        // SETEX — O(1): write HMAC-signed value + TTL on a single known key.
        await cache.setex(cacheKey, GOD_CACHE_TTL, _encodeGodCache(userId, isGod));
      } catch {
        /* cache unavailable */
      }
    }

    return isGod;
  } catch {
    return false; // Fail closed — if DB is down, do NOT grant god access
  }
}

/**
 * Invalidates the god-role cache for a user (call when user role changes).
 *
 * Complexity breakdown:
 *   DEL god:{userId}  — O(1): deletes exactly one key by its full name.
 *                       No keyspace scan is performed. KEYS-based alternatives
 *                       would be O(N) over the total number of keys in Valkey,
 *                       blocking the server during the scan.
 */
export async function invalidateGodCache(userId: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  try {
    // O(1) — DEL on a single, fully-qualified key.
    await cache.del(`god:${userId}`);
  } catch {
    /* cache unavailable */
  }
}

export async function checkPermission(
  userId: string,
  resource: string,
  action: string,
): Promise<boolean> {
  // ═══ HARDCODED GOD BYPASS ═══
  // Independent of Casbin — even if ALL policies are deleted,
  // a user with role='god' will ALWAYS have full access.
  const isGod = await isGodUser(userId);
  if (isGod) return true;

  const cache = getCache();
  const cacheKey = `perm:${userId}:${resource}:${action}`;

  if (cache) {
    try {
      // GET — O(1): direct key lookup.
      const cached = await cache.get(cacheKey);
      if (cached !== null) return cached === '1';
    } catch {
      /* cache unavailable */
    }
  }

  const e = await getEnforcer();
  const result = await e.enforce(userId, resource, action);

  if (cache) {
    try {
      // SETEX  — O(1): write the result under a fully-qualified key.
      // SADD   — O(1): add the key name to the per-user tracking Set.
      //                The Set has at most one entry per (resource, action) pair
      //                this user has ever been checked against; it is bounded by
      //                the user's own policy surface, not by the total keyspace.
      // EXPIRE — O(1): refresh TTL on the tracking Set.
      //
      // Total cache-write cost: O(1) — no scan, no iteration.
      await cache.setex(cacheKey, PERMISSION_CACHE_TTL, result ? '1' : '0');
      await cache.sadd(`user:perm-keys:${userId}`, cacheKey);
      await cache.expire(`user:perm-keys:${userId}`, PERMISSION_CACHE_TTL + 60);
    } catch {
      /* cache unavailable */
    }
  }

  return result;
}

export async function getUserRoles(userId: string): Promise<string[]> {
  const cache = getCache();
  const cacheKey = `roles:${userId}`;

  if (cache) {
    try {
      // GET — O(1): direct key lookup.
      const cached = await cache.get(cacheKey);
      if (cached !== null) return JSON.parse(cached);
    } catch {
      /* cache unavailable */
    }
  }

  const e = await getEnforcer();
  const roles = await e.getRolesForUser(userId);

  if (cache) {
    try {
      // SETEX  — O(1): write serialised roles under a single key.
      // SADD   — O(1): register this key in the per-user tracking Set
      //                so it is included in bulk invalidation.
      // EXPIRE — O(1): keeps the tracking Set TTL aligned with its contents.
      await cache.setex(cacheKey, ROLE_CACHE_TTL, JSON.stringify(roles));
      await cache.sadd(`user:perm-keys:${userId}`, cacheKey);
      await cache.expire(`user:perm-keys:${userId}`, ROLE_CACHE_TTL + 60);
    } catch {
      /* cache unavailable */
    }
  }

  return roles;
}

/**
 * Invalidates all permission and role cache entries for a single user.
 *
 * Design: instead of scanning the keyspace (KEYS or SCAN), every cache write
 * registers its key in a per-user Set (`user:perm-keys:{userId}`).
 * Invalidation then reads only that Set and deletes the listed keys.
 *
 * Complexity breakdown:
 *   SMEMBERS user:perm-keys:{userId}
 *     — O(M) where M = number of distinct (resource, action) pairs ever checked
 *       for this user. M is bounded by the user's own policy surface (typically
 *       single-digit to low tens), not by the total number of keys in Valkey.
 *
 *   DEL key₁ key₂ … keyₘ  roles:{userId}  user:perm-keys:{userId}
 *     — O(M + 2) = O(M): removes M permission keys plus the roles and
 *       tracking-Set keys in a single round-trip.
 *
 *   Total invalidation cost: O(M) — strictly scoped to this user.
 *
 * Comparison with alternatives:
 *   KEYS perm:${userId}:*   — O(N) over the full keyspace; blocks Valkey while
 *                              iterating; prohibited in production.
 *   SCAN cursor MATCH …     — O(N) total across all iterations; non-blocking per
 *                              call but still touches every key slot; unnecessary
 *                              here because we track keys explicitly at write time.
 */
export async function invalidateUserPermCache(userId: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  try {
    // O(M) — SMEMBERS returns all members of the per-user tracking Set.
    //        M is the number of distinct permission checks cached for this user.
    const permKeys = await cache.smembers(`user:perm-keys:${userId}`);

    // O(M) — DEL on M permission keys + roles key + the tracking Set itself.
    const allKeys = [...permKeys, `roles:${userId}`, `user:perm-keys:${userId}`];
    if (allKeys.length > 0) await cache.del(...allKeys);
  } catch {
    /* cache unavailable */
  }
}
