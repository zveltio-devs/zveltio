import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission, getEnforcer } from '../lib/permissions.js';
import { invalidateColumnPermCache } from '../lib/column-permissions.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { getCache } from '../lib/runtime/index.js';
import { auditLog } from '../lib/audit.js';
import type { RequestUser } from './data.js';
import { invalidateRateLimitCache } from '../middleware/rate-limit.js';
import { registerSystemRoutes } from './admin/system-routes.js';
import { registerPermissionRoutes } from './admin/permission-routes.js';
import { registerConfigRoutes } from './admin/config-routes.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function adminRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  registerSystemRoutes(app, db);
  registerPermissionRoutes(app, db);
  registerConfigRoutes(app, db);
  return app;
}

/**
 * Standalone API-key routes mounted at /api/api-keys.
 * Mirrors the /api-keys sub-routes inside adminRoutes but at a top-level path
 * so that the SDK and tests can call POST /api/api-keys directly.
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function apiKeysRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await (async () => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return null;
      if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
      return session.user;
    })();
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET / — List API keys
  app.get('/', async (c) => {
    const { page = '1', limit = '50' } = c.req.query();
    const parsedLimit = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * parsedLimit;
    const keys = await db
      .selectFrom('zv_api_keys')
      .select([
        'id',
        'name',
        'key_prefix',
        'scopes',
        'rate_limit',
        'expires_at',
        'last_used_at',
        'is_active',
        'created_at',
      ])
      .orderBy('created_at', 'desc')
      .limit(parsedLimit)
      .offset(offset)
      .execute();
    return c.json({ api_keys: keys });
  });

  // POST / — Create API key
  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        scopes: z
          .array(
            z.object({
              collection: z.string(),
              actions: z.array(z.string()),
            }),
          )
          .default([]),
        rate_limit: z.number().int().default(1000),
        expires_at: z.string().optional(),
      }),
    ),
    async (c) => {
      const user = c.get('user') as RequestUser;
      const { name, scopes, rate_limit, expires_at } = c.req.valid('json');

      const rawKey = `zvk_${crypto.randomUUID().replace(/-/g, '')}`;
      const prefix = rawKey.substring(0, 12);

      const authSecret = process.env.BETTER_AUTH_SECRET ?? process.env.SECRET_KEY ?? '';
      if (!authSecret) {
        return c.json({ error: 'Server configuration error: auth secret not set' }, 500);
      }
      const encoder = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(authSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const hashBuffer = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(rawKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const apiKey = await db
        .insertInto('zv_api_keys')
        .values({
          name,
          key_hash: keyHash,
          key_prefix: prefix,
          scopes: JSON.stringify(scopes),
          rate_limit,
          expires_at: expires_at ? new Date(expires_at) : null,
          created_by: user.id,
          is_active: true,
          request_count: 0,
        })
        .returningAll()
        .executeTakeFirst();

      await auditLog(db, {
        type: 'api_key.created',
        userId: user.id,
        resourceId: apiKey?.id,
        resourceType: 'api_key',
        metadata: { name, scopes },
      });

      return c.json({ ...apiKey, key: rawKey });
    },
  );

  // DELETE /:id — Revoke API key
  app.delete('/:id', async (c) => {
    const keyId = c.req.param('id');
    await db.updateTable('zv_api_keys').set({ is_active: false }).where('id', '=', keyId).execute();
    const user = c.get('user') as RequestUser;
    await auditLog(db, {
      type: 'api_key.revoked',
      userId: user?.id,
      resourceId: keyId,
      resourceType: 'api_key',
    });
    return c.json({ success: true });
  });

  // PUT /:id/rate-limit — Set per-key rate limit override
  app.put(
    '/:id/rate-limit',
    zValidator(
      'json',
      z.object({
        window_ms: z.number().int().min(1000).max(3_600_000),
        max_requests: z.number().int().min(1).max(100_000),
      }),
    ),
    async (c) => {
      const { id } = c.req.param();
      const { window_ms, max_requests } = c.req.valid('json');

      // Verify API key exists
      const key = await db
        .selectFrom('zv_api_keys')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!key) return c.json({ error: 'API key not found' }, 404);

      const keyPrefix = `apikey:${id}`;
      await db
        .insertInto('zv_rate_limit_configs')
        .values({
          key_prefix: keyPrefix,
          window_ms,
          max_requests,
          description: `Per-key override for ${id}`,
        })
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        .onConflict((oc: any) =>
          oc.column('key_prefix').doUpdateSet({ window_ms, max_requests, updated_at: new Date() }),
        )
        .execute();

      invalidateRateLimitCache(keyPrefix);

      const user = c.get('user') as RequestUser;
      await auditLog(db, {
        type: 'api_key.rate_limit_set',
        userId: user?.id,
        resourceId: id,
        resourceType: 'api_key',
        metadata: { window_ms, max_requests },
      });
      return c.json({ success: true, key_prefix: keyPrefix, window_ms, max_requests });
    },
  );

  // DELETE /:id/rate-limit — Remove per-key rate limit override (falls back to tier default)
  app.delete('/:id/rate-limit', async (c) => {
    const keyPrefix = `apikey:${c.req.param('id')}`;
    await db.deleteFrom('zv_rate_limit_configs').where('key_prefix', '=', keyPrefix).execute();
    invalidateRateLimitCache(keyPrefix);

    const user = c.get('user') as RequestUser;
    await auditLog(db, {
      type: 'api_key.rate_limit_removed',
      userId: user?.id,
      resourceId: c.req.param('id'),
      resourceType: 'api_key',
    });
    return c.json({ success: true });
  });

  return app;
}
