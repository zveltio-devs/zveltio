import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { getCache } from '../lib/cache.js';
import { auditLog } from '../lib/audit.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

export function adminRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // ── System Status ─────────────────────────────────────────────

  // GET /status — Full system status
  app.get('/status', async (c) => {
    const cache = getCache();
    const [dbStatus, pgVersion, tableCount, cacheStatus] = await Promise.all([
      sql`SELECT 1`.execute(db).then(() => 'connected').catch(() => 'disconnected'),
      sql<{ version: string }>`SELECT version()`.execute(db).then((r) => r.rows[0]?.version).catch(() => 'unknown'),
      sql<{ count: string }>`
        SELECT COUNT(*) as count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `.execute(db).then((r) => r.rows[0]?.count ?? '0').catch(() => '0'),
      cache
        ? cache.ping().then(() => 'connected').catch(() => 'disconnected')
        : Promise.resolve('not_configured'),
    ]);

    return c.json({
      status: 'ok',
      database: { status: dbStatus, version: pgVersion, tables: parseInt(tableCount) },
      cache: { status: cacheStatus },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
  });

  // ── API Keys ──────────────────────────────────────────────────

  // GET /api-keys — List API keys
  app.get('/api-keys', async (c) => {
    const keys = await db
      .selectFrom('zv_api_keys' as any)
      .select(['id', 'name', 'key_prefix', 'scopes', 'rate_limit', 'expires_at', 'last_used_at', 'is_active', 'created_at'] as any)
      .orderBy('created_at' as any, 'desc')
      .execute();
    return c.json({ api_keys: keys });
  });

  // POST /api-keys — Create API key
  app.post(
    '/api-keys',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        scopes: z.array(z.object({
          collection: z.string(),
          actions: z.array(z.string()),
        })).default([]),
        rate_limit: z.number().int().default(1000),
        expires_at: z.string().optional(),
      }),
    ),
    async (c) => {
      const user = c.get('user') as any;
      const { name, scopes, rate_limit, expires_at } = c.req.valid('json');

      // Generate key
      const rawKey = `zvk_${crypto.randomUUID().replace(/-/g, '')}`;
      const prefix = rawKey.substring(0, 12);

      // Security: HMAC-SHA256 with the auth secret as a salt.
      // SHA-256 without a secret is vulnerable to rainbow table attacks because
      // API keys follow a predictable format (zvk_ prefix + 32 hex chars).
      const authSecret = process.env.BETTER_AUTH_SECRET ?? process.env.SECRET_KEY ?? '';
      if (!authSecret) {
        return c.json({ error: 'Server configuration error: auth secret not set' }, 500);
      }
      const encoder = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        'raw', encoder.encode(authSecret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      );
      const hashBuffer = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(rawKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const apiKey = await db
        .insertInto('zv_api_keys' as any)
        .values({
          name,
          key_hash: keyHash,
          key_prefix: prefix,
          scopes: JSON.stringify(scopes),
          rate_limit,
          expires_at: expires_at ? new Date(expires_at) : null,
          created_by: user.id,
        } as any)
        .returningAll()
        .executeTakeFirst();

      await auditLog(db, {
        type: 'api_key.created',
        userId: user.id,
        resourceId: (apiKey as any)?.id,
        resourceType: 'api_key',
        metadata: { name, scopes },
      });

      // Return the raw key only once
      return c.json({ api_key: { ...(apiKey as any), key: rawKey } }, 201);
    },
  );

  // DELETE /api-keys/:id — Revoke API key
  app.delete('/api-keys/:id', async (c) => {
    const keyId = c.req.param('id');
    await db
      .updateTable('zv_api_keys' as any)
      .set({ is_active: false } as any)
      .where('id' as any, '=', keyId)
      .execute();
    const user = c.get('user') as any;
    await auditLog(db, {
      type: 'api_key.revoked',
      userId: user?.id,
      resourceId: keyId,
      resourceType: 'api_key',
    });
    return c.json({ success: true });
  });

  // PATCH /api-keys/:id — Update API key (scopes, IPs, permissions_mode, etc.)
  app.patch(
    '/api-keys/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().optional(),
        scopes: z.array(z.object({ collection: z.string(), actions: z.array(z.string()) })).optional(),
        allowed_ips: z.array(z.string()).nullable().optional(),
        organization: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        permissions_mode: z.enum(['scoped', 'casbin', 'god']).optional(),
        casbin_subject: z.string().nullable().optional(),
        rate_limit: z.number().int().optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param('id');
      const data = c.req.valid('json');
      await db.updateTable('zv_api_keys' as any).set(data as any).where('id' as any, '=', id).execute();
      return c.json({ success: true });
    },
  );

  // GET /api-keys/:id/access-log — Access log for a specific API key
  app.get('/api-keys/:id/access-log', async (c) => {
    const logs = await sql`
      SELECT * FROM zv_api_key_access_log
      WHERE api_key_id = ${c.req.param('id')}
      ORDER BY created_at DESC LIMIT 100
    `.execute(db);
    return c.json({ logs: logs.rows });
  });

  // ── Notifications ─────────────────────────────────────────────

  // GET /notifications — User notifications
  app.get('/notifications', async (c) => {
    const user = c.get('user') as any;
    const { unread_only } = c.req.query();

    let query = (db as any)
      .selectFrom('zv_notifications')
      .selectAll()
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .limit(50);

    if (unread_only === 'true') query = query.where('is_read', '=', false);

    const notifications = await query.execute();
    return c.json({ notifications });
  });

  // PATCH /notifications/:id/read — Mark notification as read
  app.patch('/notifications/:id/read', async (c) => {
    const user = c.get('user') as any;
    await (db as any)
      .updateTable('zv_notifications')
      .set({ is_read: true })
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // POST /notifications/mark-all-read — Mark all as read
  app.post('/notifications/mark-all-read', async (c) => {
    const user = c.get('user') as any;
    await (db as any)
      .updateTable('zv_notifications')
      .set({ is_read: true })
      .where('user_id', '=', user.id)
      .where('is_read', '=', false)
      .execute();
    return c.json({ success: true });
  });

  // ── Audit / Revisions ────────────────────────────────────────

  // GET /revisions — Audit trail
  app.get('/revisions', async (c) => {
    const { collection, record_id, user_id, limit = '50', page = '1' } = c.req.query();
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = (db as any)
      .selectFrom('zv_revisions')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit))
      .offset(offset);

    if (collection) query = query.where('collection', '=', collection);
    if (record_id) query = query.where('record_id', '=', record_id);
    if (user_id) query = query.where('user_id', '=', user_id);

    const revisions = await query.execute();
    return c.json({ revisions });
  });

  // ── Field Types ───────────────────────────────────────────────

  // GET /field-types — All registered field types (including from extensions)
  app.get('/field-types', (c) => {
    return c.json({ field_types: fieldTypeRegistry.getAll() });
  });

  // ── TypeScript Types ─────────────────────────────────────────

  // GET /types/:collection — Generate TypeScript types for a collection
  app.get('/types/:collection', async (c) => {
    const collection = await DDLManager.getCollection(db, c.req.param('collection'));
    if (!collection) return c.json({ error: 'Collection not found' }, 404);

    const tsTypes = fieldTypeRegistry.generateTypeScript(
      collection.name,
      JSON.parse(collection.fields),
    );

    c.header('Content-Type', 'text/plain');
    return c.body(tsTypes);
  });

  // GET /types — TypeScript types for all collections
  app.get('/types', async (c) => {
    const collections = await DDLManager.getCollections(db);
    const types = collections
      .map((col: any) => {
        const fields = typeof col.fields === 'string' ? JSON.parse(col.fields) : col.fields;
        return fieldTypeRegistry.generateTypeScript(col.name, fields);
      })
      .join('\n\n');

    c.header('Content-Type', 'text/plain');
    return c.body(`// Auto-generated by Zveltio\n// Do not edit manually\n\n${types}`);
  });

  // ── Schema / Migrations ───────────────────────────────────────

  // POST /migrate — run pending migrations (admin only)
  app.post('/migrate', async (c) => {
    try {
      const { runMigrations, getLastAppliedMigration } = await import(
        '../db/migrations/index.js'
      );
      const before = await getLastAppliedMigration(db);
      await runMigrations(db);
      const after = await getLastAppliedMigration(db);

      return c.json({
        success: true,
        applied: after - before,
        schema_version: after,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // GET /schema — schema status and migration history
  app.get('/schema', async (c) => {
    const { getAppliedMigrations, getLastAppliedMigration } = await import(
      '../db/migrations/index.js'
    );
    const { getVersionInfo, MAX_SCHEMA_VERSION } = await import('../version.js');

    const [migrations, current] = await Promise.all([
      getAppliedMigrations(db),
      getLastAppliedMigration(db),
    ]);

    return c.json({
      ...getVersionInfo(current),
      migrations,
      max_schema_version: MAX_SCHEMA_VERSION,
    });
  });

  // ── Onboarding ────────────────────────────────────────────────

  // GET /onboarding/status
  app.get('/onboarding/status', async (c) => {
    const [users, collections, branding] = await Promise.all([
      (db as any).selectFrom('user').select((eb: any) => eb.fn.count('id').as('count')).executeTakeFirst(),
      DDLManager.getCollections(db),
      (db as any).selectFrom('zv_settings').selectAll().where('key', '=', 'branding').executeTakeFirst(),
    ]);

    const userCount = parseInt(users?.count ?? '0');
    const brandingVal = branding
      ? (typeof branding.value === 'string' ? JSON.parse(branding.value) : branding.value)
      : {};

    return c.json({
      completed: userCount > 0 && collections.length > 0,
      steps: {
        branding_configured: !!brandingVal?.company_name && brandingVal.company_name !== 'Zveltio',
        first_collection_created: collections.length > 0,
        users_created: userCount > 1,
      },
    });
  });

  return app;
}
