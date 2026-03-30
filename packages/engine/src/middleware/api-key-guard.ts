import type { Context, Next } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { hashApiKey } from '../lib/api-key-hash.js';

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
    const keyHash = await hashApiKey(rawKey);
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
    // SECURITY: x-forwarded-for and x-real-ip are client-controlled headers.
    // Without TRUSTED_PROXY=true, any client can set X-Forwarded-For: <whitelisted_ip>
    // and bypass the IP allowlist entirely. Only trust proxy headers when the engine
    // is deployed behind a known, trusted reverse proxy (e.g. nginx, Caddy, AWS ALB).
    const trustedProxy = process.env.TRUSTED_PROXY === 'true';
    const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
    const IPV6_RE = /^[0-9a-f:]{2,39}$/i;
    const rawForwardedFor = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    const forwardedIp =
      trustedProxy && rawForwardedFor && (IPV4_RE.test(rawForwardedFor) || IPV6_RE.test(rawForwardedFor))
        ? rawForwardedFor
        : null;
    const realIp = trustedProxy ? c.req.header('x-real-ip') ?? null : null;
    const clientIp = forwardedIp || realIp || 'unknown';

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

    // 4. Update stats (fire-and-forget — non-blocking; failures are logged in dev)
    sql`UPDATE zv_api_keys SET request_count = request_count + 1, last_used_at = NOW(), last_ip = ${clientIp} WHERE id = ${apiKey.id}`
      .execute(db)
      .catch((err) => {
        if (process.env.NODE_ENV !== 'production') {
          console.error('[api-key-guard] stats update failed:', err);
        }
      });

    c.set('user', {
      id: `api_key:${apiKey.id}`,
      name: apiKey.name,
      role: 'api_key',
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
