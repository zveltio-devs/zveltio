import type { Context, Next } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';

/**
 * Middleware for Protected API:
 * 1. Validates API key (X-API-Key header)
 * 2. Checks IP whitelisting
 * 3. Checks scopes or Casbin permissions
 * 4. Logs access
 */
export function apiKeyGuard(db: Database) {
  return async (c: Context, next: Next) => {
    const rawKey = c.req.header('X-API-Key');
    if (!rawKey) return c.json({ error: 'API key required (X-API-Key header)' }, 401);

    // 1. Validate key
    const keyHash = await hashKey(rawKey);
    const apiKey = await (db as any)
      .selectFrom('zv_api_keys')
      .selectAll()
      .where('key_hash', '=', keyHash)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!apiKey) return c.json({ error: 'Invalid API key' }, 401);
    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      return c.json({ error: 'API key expired' }, 401);
    }

    // 2. IP Whitelisting
    const clientIp =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      'unknown';

    if (apiKey.allowed_ips && apiKey.allowed_ips.length > 0) {
      const allowed = apiKey.allowed_ips.some((ip: string) =>
        ip.includes('/') ? isIpInCidr(clientIp, ip) : ip === clientIp,
      );
      if (!allowed) {
        logAccess(db, apiKey.id, clientIp, c.req.method, c.req.path, 403).catch(() => {});
        return c.json({ error: `IP ${clientIp} not allowed for this API key` }, 403);
      }
    }

    // 3. Permission check
    const collection = extractCollection(c.req.path);
    const action = methodToAction(c.req.method);

    if (apiKey.permissions_mode === 'god') {
      // Full access — for internal system keys only
    } else if (apiKey.permissions_mode === 'casbin' && apiKey.casbin_subject) {
      const allowed = await checkPermission(apiKey.casbin_subject, `data:${collection}`, action);
      if (!allowed) {
        logAccess(db, apiKey.id, clientIp, c.req.method, c.req.path, 403).catch(() => {});
        return c.json({ error: 'Insufficient permissions' }, 403);
      }
    } else {
      const scopes =
        typeof apiKey.scopes === 'string' ? JSON.parse(apiKey.scopes) : apiKey.scopes;
      if (!checkScopes(scopes, collection, action)) {
        logAccess(db, apiKey.id, clientIp, c.req.method, c.req.path, 403).catch(() => {});
        return c.json({ error: 'API key does not have access to this resource' }, 403);
      }
    }

    // 4. Update stats (fire-and-forget)
    sql`UPDATE zv_api_keys SET request_count = request_count + 1, last_used_at = NOW(), last_ip = ${clientIp} WHERE id = ${apiKey.id}`
      .execute(db)
      .catch(() => {});

    c.set('user', {
      id: `api_key:${apiKey.id}`,
      name: apiKey.name,
      role: 'api_key',
      organization: apiKey.organization,
    });
    c.set('apiKey', apiKey);

    const start = Date.now();
    await next();

    logAccess(db, apiKey.id, clientIp, c.req.method, c.req.path, c.res.status, Date.now() - start).catch(() => {});
  };
}

function checkScopes(
  scopes: Array<{ collection: string; actions: string[] }>,
  collection: string,
  action: string,
): boolean {
  if (!scopes || scopes.length === 0) return false;
  return scopes.some(
    (s) =>
      (s.collection === '*' || s.collection === collection) &&
      (s.actions.includes('*') || s.actions.includes(action)),
  );
}

function extractCollection(path: string): string {
  const match = path.match(/\/api\/data\/([^/]+)/);
  return match?.[1] || '*';
}

function methodToAction(method: string): string {
  const map: Record<string, string> = {
    GET: 'read',
    POST: 'create',
    PUT: 'update',
    PATCH: 'update',
    DELETE: 'delete',
  };
  return map[method.toUpperCase()] || 'read';
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/');
  if (!bits) return ip === range;
  const mask = ~(2 ** (32 - parseInt(bits)) - 1);
  const ipNum = ipToNum(ip);
  const rangeNum = ipToNum(range);
  return (ipNum & mask) === (rangeNum & mask);
}

function ipToNum(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0);
}

async function hashKey(key: string): Promise<string> {
  // Security: HMAC-SHA256 with the auth secret — must match admin.ts key creation.
  const authSecret = process.env.BETTER_AUTH_SECRET ?? process.env.SECRET_KEY ?? '';
  if (!authSecret) throw new Error('Server configuration error: auth secret not set');
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(authSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const hashBuffer = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(key));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function logAccess(
  db: Database,
  keyId: string,
  ip: string,
  method: string,
  path: string,
  status?: number,
  duration?: number,
): Promise<void> {
  await (db as any)
    .insertInto('zv_api_key_access_log')
    .values({
      api_key_id: keyId,
      ip_address: ip,
      method,
      path,
      status_code: status ?? null,
      duration_ms: duration ?? null,
    })
    .execute()
    .catch(() => {});
}
