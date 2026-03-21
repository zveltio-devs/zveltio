import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';

// Security: only these keys can be written via the API.
// Internal/system keys that affect engine security are listed in READONLY_SETTINGS_KEYS.
const WRITABLE_SETTINGS_KEYS = new Set([
  // Branding & UI
  'branding', 'company_name', 'site_name', 'site_url', 'logo_url', 'favicon_url',
  'primary_color', 'support_email', 'contact_email', 'timezone', 'date_format', 'language',
  // Feature toggles (non-security)
  'maintenance_mode', 'registration_enabled', 'api_docs_public',
  'max_upload_size_mb', 'allowed_file_types', 'default_collection_permissions',
  // Email configuration (non-secret values only)
  'smtp_host', 'smtp_port', 'smtp_from_name', 'smtp_from_email', 'smtp_secure',
  // AI configuration (non-secret)
  'ai_enabled', 'ai_default_provider', 'ai_default_model', 'ai_max_tokens_per_request',
  // Storage configuration (non-secret)
  's3_public_url', 's3_bucket_public',
  // Monitoring
  'audit_log_retention_days', 'session_max_age_days',
]);

// These keys are system-managed and NEVER writable via the settings API.
const READONLY_SETTINGS_KEYS = new Set([
  'auth_secret', 'jwt_secret', 'encryption_key', 'database_url', 'redis_url',
  'internal_api_key', 'webhook_signing_secret', 'license_key', 'engine_version', 'schema_version',
]);

export function settingsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // GET /public — Public settings (no auth required)
  // Security: double-guard — is_public flag AND explicit whitelist.
  // Even if a sensitive key is accidentally marked is_public, it won't be served.
  const PUBLIC_SETTINGS_WHITELIST = new Set([
    'branding', 'company_name', 'site_name', 'site_url', 'logo_url', 'favicon_url',
    'primary_color', 'language', 'timezone', 'date_format', 'support_email',
    'contact_email', 'registration_enabled', 'api_docs_public', 'maintenance_mode',
    'ai_enabled', 'ai_default_model',
  ]);

  app.get('/public', async (c) => {
    const settings = await (db as any)
      .selectFrom('zv_settings')
      .selectAll()
      .where('is_public', '=', true)
      .execute();

    const result: Record<string, any> = {};
    for (const s of settings) {
      const key = (s as any).key as string;
      if (!PUBLIC_SETTINGS_WHITELIST.has(key)) continue; // extra guard
      const raw = (s as any).value;
      if (typeof raw === 'string') {
        try { result[key] = JSON.parse(raw); } catch { result[key] = raw; }
      } else {
        result[key] = raw;
      }
    }
    return c.json(result);
  });

  // All other settings require admin
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await checkPermission(session.user.id, 'admin', '*'))) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    await next();
  });

  // GET / — All settings
  app.get('/', async (c) => {
    const settings = await (db as any)
      .selectFrom('zv_settings')
      .selectAll()
      .orderBy('key')
      .execute();

    const result: Record<string, any> = {};
    for (const s of settings) {
      const raw = (s as any).value;
      if (typeof raw === 'string') {
        try { result[(s as any).key] = JSON.parse(raw); } catch { result[(s as any).key] = raw; }
      } else {
        result[(s as any).key] = raw;
      }
    }
    return c.json(result);
  });

  // GET /:key — Get a single setting
  app.get('/:key', async (c) => {
    const setting = await (db as any)
      .selectFrom('zv_settings')
      .selectAll()
      .where('key', '=', c.req.param('key'))
      .executeTakeFirst();

    if (!setting) return c.json({ error: 'Setting not found' }, 404);

    const raw = (setting as any).value;
    let parsed: any;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    } else {
      parsed = raw;
    }
    return c.json({ key: (setting as any).key, value: parsed });
  });

  // PUT /:key — Upsert a setting
  app.put(
    '/:key',
    zValidator('json', z.object({ value: z.any(), is_public: z.boolean().optional() })),
    async (c) => {
      const key = c.req.param('key');
      if (READONLY_SETTINGS_KEYS.has(key)) {
        return c.json({ error: `Setting key "${key}" is read-only and cannot be modified via the API.` }, 403);
      }
      if (!WRITABLE_SETTINGS_KEYS.has(key)) {
        return c.json({ error: `Setting key "${key}" is not a recognized writable setting.` }, 400);
      }
      const { value, is_public } = c.req.valid('json');
      // M3 FIX: JSON.stringify throws on circular references — return 400 instead of 500.
      let serialized: string;
      try {
        serialized = JSON.stringify(value);
      } catch {
        return c.json({ error: 'Value is not JSON-serializable' }, 400);
      }

      await (db as any)
        .insertInto('zv_settings')
        .values({
          key,
          value: serialized,
          is_public: is_public ?? false,
          updated_at: new Date(),
        })
        .onConflict((oc: any) =>
          oc.column('key').doUpdateSet({
            value: serialized,
            ...(is_public !== undefined ? { is_public } : {}),
            updated_at: new Date(),
          }),
        )
        .execute();

      return c.json({ success: true, key, value });
    },
  );

  // PATCH /bulk — Update multiple settings at once
  app.patch('/bulk', async (c) => {
    const body = await c.req.json();
    // Security: validate all keys before writing any of them.
    for (const key of Object.keys(body)) {
      if (READONLY_SETTINGS_KEYS.has(key)) {
        return c.json({ error: `Setting key "${key}" is read-only and cannot be modified via the API.` }, 403);
      }
      if (!WRITABLE_SETTINGS_KEYS.has(key)) {
        return c.json({ error: `Setting key "${key}" is not a recognized writable setting.` }, 400);
      }
    }
    for (const [key, value] of Object.entries(body)) {
      let serialized: string;
      try {
        serialized = JSON.stringify(value);
      } catch {
        return c.json({ error: `Value for key "${key}" is not JSON-serializable` }, 400);
      }
      await (db as any)
        .insertInto('zv_settings')
        .values({ key, value: serialized, updated_at: new Date() })
        .onConflict((oc: any) =>
          oc.column('key').doUpdateSet({ value: serialized, updated_at: new Date() }),
        )
        .execute();
    }
    return c.json({ success: true, updated: Object.keys(body) });
  });

  return app;
}
