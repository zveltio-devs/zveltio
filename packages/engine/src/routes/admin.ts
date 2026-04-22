import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission, getEnforcer } from '../lib/permissions.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { getCache } from '../lib/cache.js';
import { auditLog } from '../lib/audit.js';
import type { RequestUser } from './data.js';

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
    const { page = '1', limit = '50' } = c.req.query();
    const parsedLimit = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * parsedLimit;
    const keys = await db
      .selectFrom('zv_api_keys')
      .select(['id', 'name', 'key_prefix', 'scopes', 'rate_limit', 'expires_at', 'last_used_at', 'is_active', 'created_at'])
      .orderBy('created_at', 'desc')
      .limit(parsedLimit)
      .offset(offset)
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
      const user = c.get('user') as RequestUser;
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

      // Return the raw key only once
      return c.json({ ...apiKey, key: rawKey });
    },
  );

  // DELETE /api-keys/:id — Revoke API key
  app.delete('/api-keys/:id', async (c) => {
    const keyId = c.req.param('id');
    await db
      .updateTable('zv_api_keys')
      .set({ is_active: false })
      .where('id', '=', keyId)
      .execute();
    const user = c.get('user') as RequestUser;
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
      await db.updateTable('zv_api_keys').set(data).where('id', '=', id).execute();
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
    const user = c.get('user') as RequestUser;
    const { unread_only } = c.req.query();

    let query = db
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
    const user = c.get('user') as RequestUser;
    await db
      .updateTable('zv_notifications')
      .set({ is_read: true })
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // POST /notifications/mark-all-read — Mark all as read
  app.post('/notifications/mark-all-read', async (c) => {
    const user = c.get('user') as RequestUser;
    await db
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
    // I3: cap limit to prevent DoS / OOM
    const parsedLimit = Math.min(parseInt(limit) || 50, 500);
    const offset = (parseInt(page) - 1) * parsedLimit;

    let query = db
      .selectFrom('zv_revisions')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(parsedLimit)
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
      db.selectFrom('user').select((eb) => eb.fn.count('id').as('count')).executeTakeFirst(),
      DDLManager.getCollections(db),
      db.selectFrom('zv_settings').selectAll().where('key', '=', 'branding').executeTakeFirst(),
    ]);

    const userCount = Number(users?.count ?? 0);
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

  // ── EXPLAIN ANALYZE (dev/staging only) ───────────────────────

  // POST /explain — EXPLAIN ANALYZE a Kysely query (admin only, dev/staging only)
  app.post('/explain', async (c) => {
    if (process.env.NODE_ENV === 'production') {
      return c.json({ error: 'EXPLAIN endpoint is disabled in production' }, 403);
    }

    const body = await c.req.json().catch(() => null);
    if (!body?.collection) {
      return c.json({ error: 'collection is required' }, 400);
    }

    const { collection, sort = 'created_at', order = 'desc', limit = 20 } = body;

    // Validate collection name (alphanumeric + underscore only)
    if (!/^[a-zA-Z0-9_]+$/.test(collection)) {
      return c.json({ error: 'Invalid collection name' }, 400);
    }

    // Build a safe table name
    const tableName = collection.startsWith('zvd_') ? collection : `zvd_${collection}`;

    // Validate sort field
    if (!/^[a-zA-Z0-9_]+$/.test(sort)) {
      return c.json({ error: 'Invalid sort field' }, 400);
    }

    const safeOrder = order === 'asc' ? 'ASC' : 'DESC';
    const safeLimit = Math.min(Math.max(parseInt(String(limit)) || 20, 1), 500);

    try {
      const { sql: sqlHelper } = await import('kysely');
      const result = await sqlHelper<any>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT * FROM ${sqlHelper.table(tableName)}
        ORDER BY ${sqlHelper.ref(sort)} ${sqlHelper.raw(safeOrder)}
        LIMIT ${safeLimit}
      `.execute(db);

      return c.json({ plan: result.rows[0] });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── Audit Log ─────────────────────────────────────────────────

  // GET /audit — recent security/admin events from zv_audit_log
  app.get('/audit', async (c) => {
    const { limit = '50', page = '1', user_id, event_type } = c.req.query();
    const parsedLimit = Math.min(parseInt(limit) || 50, 500);
    const offset = (parseInt(page) - 1) * parsedLimit;

    let query = db
      .selectFrom('zv_audit_log')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(parsedLimit)
      .offset(offset);

    if (user_id) query = query.where('user_id', '=', user_id);
    if (event_type) query = query.where('event_type', '=', event_type);

    const entries = await query.execute();
    return c.json({ audit: entries });
  });

  // ── Dashboard Stats ────────────────────────────────────────────

  // GET /stats — aggregate stats for the dashboard
  app.get('/stats', async (c) => {
    const [collectionsCount, webhooksCount, slowCount, apiCallsToday] = await Promise.all([
      sql<{ count: string }>`
        SELECT COUNT(*) AS count FROM zv_collections
      `.execute(db).then((r) => parseInt(r.rows[0]?.count ?? '0')).catch(() => 0),
      sql<{ count: string }>`
        SELECT COUNT(*) AS count FROM zv_webhooks WHERE active = TRUE
      `.execute(db).then((r) => parseInt(r.rows[0]?.count ?? '0')).catch(() => 0),
      sql<{ count: string }>`
        SELECT COUNT(*) AS count FROM zv_slow_queries
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      `.execute(db).then((r) => parseInt(r.rows[0]?.count ?? '0')).catch(() => 0),
      sql<{ count: string }>`
        SELECT COALESCE(SUM(api_calls), 0) AS count FROM zv_tenant_quota
        WHERE date = CURRENT_DATE
      `.execute(db).then((r) => parseInt(r.rows[0]?.count ?? '0')).catch(() => 0),
    ]);

    return c.json({
      collections: collectionsCount,
      active_webhooks: webhooksCount,
      slow_queries_24h: slowCount,
      api_calls_today: apiCallsToday,
    });
  });

  // ── Request Logs ──────────────────────────────────────────────

  // GET /logs — recent request log (filterable by path, status, method)
  app.get('/logs', async (c) => {
    const { limit = '100', page = '1', path, status, method, user_id } = c.req.query();
    const parsedLimit = Math.min(parseInt(limit) || 100, 1000);
    const offset = (parseInt(page) - 1) * parsedLimit;

    let query = (db as any)
      .selectFrom('zv_request_logs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(parsedLimit)
      .offset(offset);

    if (path) query = query.where('path', 'like', `%${path}%`);
    if (status) query = query.where('status', '=', parseInt(status));
    if (method) query = query.where('method', '=', method.toUpperCase());
    if (user_id) query = query.where('user_id', '=', user_id);

    const [logs, total] = await Promise.all([
      query.execute(),
      (db as any).selectFrom('zv_request_logs')
        .select((eb: any) => eb.fn.count('id').as('count'))
        .executeTakeFirst(),
    ]);

    return c.json({ logs, total: Number(total?.count ?? 0) });
  });

  // ── Slow Queries ──────────────────────────────────────────────

  // GET /slow-queries — list recent slow queries
  app.get('/slow-queries', async (c) => {
    const { limit = '50', min_ms = '200' } = c.req.query();
    const rows = await db
      .selectFrom('zv_slow_queries')
      .selectAll()
      .where('duration_ms', '>=', parseInt(min_ms) || 200)
      .orderBy('created_at', 'desc')
      .limit(Math.min(parseInt(limit) || 50, 500))
      .execute();
    return c.json({ slow_queries: rows });
  });

  // ── Permissions UI helpers ────────────────────────────────────
  // These endpoints back the Studio permissions matrix page.

  // GET /collections — Collections list (for permission matrix columns)
  app.get('/collections', async (c) => {
    const collections = await DDLManager.getCollections(db);
    return c.json({ collections });
  });

  // GET /resources — All permission-addressable resources: collections + zones.
  // Collections use actions: view, create, update, delete.
  // Zones use actions: read, write (portal/intranet access model).
  app.get('/resources', async (c) => {
    const [collections, zones] = await Promise.all([
      DDLManager.getCollections(db),
      db.selectFrom('zvd_zones').select(['slug', 'name']).orderBy('name', 'asc').execute(),
    ]);
    const resources = [
      ...collections.map((col) => ({
        name: col.name,
        display_name: col.display_name || col.name,
        type: 'collection' as const,
        actions: ['view', 'create', 'update', 'delete'],
      })),
      ...zones.map((z) => ({
        name: z.slug,
        display_name: z.name,
        type: 'zone' as const,
        actions: ['read', 'write'],
      })),
    ];
    return c.json({ resources });
  });

  // GET /roles — List custom roles
  app.get('/roles', async (c) => {
    const roles = await db
      .selectFrom('zv_roles')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
    return c.json({ roles });
  });

  // POST /roles — Create a custom role
  app.post(
    '/roles',
    zValidator('json', z.object({
      name: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/, 'Role name must be lowercase letters, digits, _ or -'),
      description: z.string().optional(),
    })),
    async (c) => {
      const { name, description } = c.req.valid('json');
      const existing = await db
        .selectFrom('zv_roles')
        .where('name', '=', name)
        .selectAll()
        .executeTakeFirst();
      if (existing) return c.json({ error: `Role "${name}" already exists` }, 409);
      const role = await db
        .insertInto('zv_roles')
        .values({ name, description: description ?? null })
        .returningAll()
        .executeTakeFirst();
      return c.json({ role }, 201);
    },
  );

  // DELETE /roles/:id — Delete a custom role and its Casbin policies
  app.delete('/roles/:id', async (c) => {
    const id = c.req.param('id');
    const role = await db
      .selectFrom('zv_roles')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();
    if (!role) return c.json({ error: 'Role not found' }, 404);

    // Remove all Casbin policies for this role name
    const e = await getEnforcer();
    await e.deletePermissionsForUser(role.name);
    await e.deleteRole(role.name);

    await db.deleteFrom('zv_roles').where('id', '=', id).execute();
    await invalidatePermissionCache();
    return c.json({ success: true });
  });

  // GET /permissions — All custom-role permissions (ptype='p' from zvd_permissions)
  app.get('/permissions', async (c) => {
    const roles = await db.selectFrom('zv_roles').selectAll().execute();
    const roleNameToId = new Map<string, string>(roles.map((r) => [r.name, r.id]));

    const policies = await db
      .selectFrom('zvd_permissions')
      .selectAll()
      .where('ptype', '=', 'p')
      .execute();

    const permissions = policies
      .filter((p) => roleNameToId.has(p.v0))
      .map((p) => ({
        role_id: roleNameToId.get(p.v0),
        resource: p.v1,
        action: p.v2,
      }));

    return c.json({ permissions });
  });

  // POST /permissions/bulk — Replace all custom-role permissions atomically
  app.post(
    '/permissions/bulk',
    zValidator('json', z.object({
      permissions: z.array(z.object({
        role_id: z.string().uuid(),
        resource: z.string().min(1),
        action: z.enum(['view', 'create', 'update', 'delete', 'read', 'write', '*']),
      })),
    })),
    async (c) => {
      const { permissions } = c.req.valid('json');
      const roles = await db.selectFrom('zv_roles').selectAll().execute();
      const roleIdToName = new Map<string, string>(roles.map((r) => [r.id, r.name]));

      const e = await getEnforcer();

      // Remove all existing policies for custom roles
      for (const role of roles) {
        await e.deletePermissionsForUser(role.name);
      }

      // Add new policies
      for (const perm of permissions) {
        const roleName = roleIdToName.get(perm.role_id);
        if (!roleName) continue;
        await e.addPolicy(roleName, perm.resource, perm.action);
      }

      await invalidatePermissionCache();
      return c.json({ success: true });
    },
  );

  // ── Role Hierarchy (Casbin `g` role-role inheritance) ────────
  //
  // Casbin supports: g, child_role, parent_role
  // Example: g, manager, employee  → manager inherits all employee perms
  //
  // This enables RBAC hierarchies like:
  //   god → admin → manager → employee
  //
  // The UI can visualize this as an inheritance tree and let admins
  // define which roles inherit from which others.

  // GET /roles/hierarchy — All role-role inheritance edges
  app.get('/roles/hierarchy', async (c) => {
    const edges = await db
      .selectFrom('zvd_permissions')
      .select(['v0 as child', 'v1 as parent'])
      .where('ptype', '=', 'g')
      .execute()
      .catch(() => [] as { child: string; parent: string }[]);

    // Filter out user-role assignments (UUID v0) — keep only role-role edges
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const filtered = edges.filter((e) => !uuidRe.test(e.child));

    return c.json({ hierarchy: filtered });
  });

  // POST /roles/hierarchy — Add inheritance: child_role inherits parent_role
  app.post(
    '/roles/hierarchy',
    zValidator('json', z.object({
      child: z.string().min(1),
      parent: z.string().min(1),
    })),
    async (c) => {
      const { child, parent } = c.req.valid('json');
      if (child === parent) return c.json({ error: 'A role cannot inherit from itself' }, 400);

      const e = await getEnforcer();
      // Check for circular inheritance
      const parentRoles = await e.getRolesForUser(parent);
      if (parentRoles.includes(child)) {
        return c.json({ error: `Circular inheritance: "${parent}" already inherits from "${child}"` }, 409);
      }
      await e.addRoleForUser(child, parent);
      await invalidatePermissionCache();
      return c.json({ success: true, child, parent });
    },
  );

  // DELETE /roles/hierarchy — Remove inheritance
  app.delete(
    '/roles/hierarchy',
    zValidator('json', z.object({
      child: z.string().min(1),
      parent: z.string().min(1),
    })),
    async (c) => {
      const { child, parent } = c.req.valid('json');
      const e = await getEnforcer();
      await e.deleteRoleForUser(child, parent);
      await invalidatePermissionCache();
      return c.json({ success: true });
    },
  );

  // ── SQL Editor (admin-only, safe read/write with timeout) ─────

  app.post(
    '/sql',
    zValidator('json', z.object({
      query: z.string().min(1).max(50_000),
      timeout_ms: z.number().int().min(100).max(30_000).optional(),
    })),
    async (c) => {
      const { query, timeout_ms = 10_000 } = c.req.valid('json');

      // Reject obviously dangerous patterns
      const normalized = query.trim().toUpperCase();
      const BLOCKED = ['DROP DATABASE', 'DROP SCHEMA', 'ALTER SYSTEM', 'COPY TO', 'COPY FROM'];
      for (const pat of BLOCKED) {
        if (normalized.includes(pat)) {
          return c.json({ error: `Blocked statement: ${pat}` }, 400);
        }
      }

      try {
        const result = await sql.raw(query).execute(db) as any;
        const rows = result.rows ?? [];
        return c.json({ rows, rowCount: rows.length });
      } catch (err: any) {
        return c.json({ error: err.message ?? String(err) }, 400);
      }
    },
  );

  return app;
}

async function invalidatePermissionCache() {
  const cache = getCache();
  if (!cache) return;
  try {
    const allKeys: string[] = [];
    for (const pattern of ['perm:*', 'roles:*', 'god:*']) {
      let cursor = '0';
      do {
        const [nextCursor, batch] = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        allKeys.push(...batch);
      } while (cursor !== '0');
    }
    if (allKeys.length > 0) await cache.del(...allKeys);
  } catch { /* cache unavailable */ }
}

/**
 * Standalone API-key routes mounted at /api/api-keys.
 * Mirrors the /api-keys sub-routes inside adminRoutes but at a top-level path
 * so that the SDK and tests can call POST /api/api-keys directly.
 */
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
      .select(['id', 'name', 'key_prefix', 'scopes', 'rate_limit', 'expires_at', 'last_used_at', 'is_active', 'created_at'])
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
        scopes: z.array(z.object({
          collection: z.string(),
          actions: z.array(z.string()),
        })).default([]),
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
        'raw', encoder.encode(authSecret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
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
    await db
      .updateTable('zv_api_keys')
      .set({ is_active: false })
      .where('id', '=', keyId)
      .execute();
    const user = c.get('user') as RequestUser;
    await auditLog(db, {
      type: 'api_key.revoked',
      userId: user?.id,
      resourceId: keyId,
      resourceType: 'api_key',
    });
    return c.json({ success: true });
  });

  return app;
}
