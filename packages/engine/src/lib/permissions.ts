import { newEnforcer, type Enforcer } from 'casbin';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { getRedis } from './redis.js';

// Cache TTLs
const PERMISSION_CACHE_TTL = 60;  // seconds
const ROLE_CACHE_TTL = 300;       // seconds
const GOD_CACHE_TTL = 300;        // seconds

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
      const tokens = [line.ptype, line.v0, line.v1, line.v2, line.v3, line.v4, line.v5].filter(
        (v): v is string => v !== null,
      );
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

  async removePolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
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
    if (fieldValues[0] !== undefined) conditions.push(sql`v0 = ${fieldValues[0]}`);
    if (fieldValues[1] !== undefined) conditions.push(sql`v1 = ${fieldValues[1]}`);
    if (fieldValues[2] !== undefined) conditions.push(sql`v2 = ${fieldValues[2]}`);

    await sql`DELETE FROM zvd_permissions WHERE ${sql.join(conditions, sql` AND `)}`.execute(_db);
  }
}

export async function initPermissions(db: Database): Promise<void> {
  _db = db;
  _enforcer = await newEnforcer(CASBIN_MODEL, new KyselyCasbinAdapter());
}

export async function getEnforcer(): Promise<Enforcer> {
  if (!_enforcer) throw new Error('Permissions not initialized. Call initPermissions() first.');
  return _enforcer;
}

/**
 * Checks if a user has the "god" role — directly from DB, independent of Casbin.
 * Cached in Redis for performance. Fail-closed: returns false if DB is unavailable.
 */
async function isGodUser(userId: string): Promise<boolean> {
  const redis = getRedis();
  const cacheKey = `god:${userId}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) return cached === '1';
    } catch { /* cache unavailable */ }
  }

  try {
    const result = await sql<{ role: string }>`
      SELECT role FROM "user" WHERE id = ${userId} LIMIT 1
    `.execute(_db);

    const isGod = result.rows[0]?.role === 'god';

    if (redis) {
      try {
        await redis.setex(cacheKey, GOD_CACHE_TTL, isGod ? '1' : '0');
      } catch { /* cache unavailable */ }
    }

    return isGod;
  } catch {
    return false; // Fail closed — if DB is down, do NOT grant god access
  }
}

/**
 * Invalidates the god-role cache for a user (call when user role changes).
 */
export async function invalidateGodCache(userId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`god:${userId}`);
  } catch { /* cache unavailable */ }
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

  const redis = getRedis();
  const cacheKey = `perm:${userId}:${resource}:${action}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) return cached === '1';
    } catch { /* cache unavailable */ }
  }

  const e = await getEnforcer();
  const result = await e.enforce(userId, resource, action);

  if (redis) {
    try {
      await redis.setex(cacheKey, PERMISSION_CACHE_TTL, result ? '1' : '0');
    } catch { /* cache unavailable */ }
  }

  return result;
}

export async function getUserRoles(userId: string): Promise<string[]> {
  const redis = getRedis();
  const cacheKey = `roles:${userId}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) return JSON.parse(cached);
    } catch { /* cache unavailable */ }
  }

  const e = await getEnforcer();
  const roles = await e.getRolesForUser(userId);

  if (redis) {
    try {
      await redis.setex(cacheKey, ROLE_CACHE_TTL, JSON.stringify(roles));
    } catch { /* cache unavailable */ }
  }

  return roles;
}

export async function invalidateUserPermCache(userId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const permKeys = await redis.keys(`perm:${userId}:*`);
    const keys = [...permKeys, `roles:${userId}`];
    if (keys.length > 0) await redis.del(...keys);
  } catch { /* cache unavailable */ }
}
