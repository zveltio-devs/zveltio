import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';

// In-memory i18n cache: locale → key → value
const i18nCache = new Map<string, Map<string, string>>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cacheExpiry = 0;

function invalidateCache() {
  i18nCache.clear();
  cacheExpiry = 0;
}

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

export function translationsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // ── Public: Translation lookup ────────────────────────────────

  // GET /public/:locale — Full translation map for a locale (for frontend apps)
  app.get('/public/:locale', async (c) => {
    const locale = c.req.param('locale');

    // Check cache
    if (Date.now() < cacheExpiry && i18nCache.has(locale)) {
      return c.json({ locale, translations: Object.fromEntries(i18nCache.get(locale)!) });
    }

    const rows = await sql`
      SELECT tk.key, t.value
      FROM zvd_translations t
      JOIN zvd_translation_keys tk ON tk.id = t.key_id
      WHERE t.locale = ${locale}
    `.execute(db).catch(() => ({ rows: [] }));

    const map = new Map<string, string>();
    for (const row of rows.rows as any[]) {
      map.set(row.key, row.value);
    }

    // Fall back to default values for missing translations
    if (rows.rows.length === 0) {
      const allKeys = await sql`
        SELECT key, default_value FROM zvd_translation_keys
      `.execute(db).catch(() => ({ rows: [] }));
      for (const row of allKeys.rows as any[]) {
        if (row.default_value) map.set(row.key, row.default_value);
      }
    }

    i18nCache.set(locale, map);
    cacheExpiry = Date.now() + CACHE_TTL;

    return c.json({ locale, translations: Object.fromEntries(map) });
  });

  // ── Admin: Manage locales ─────────────────────────────────────

  app.use('/locales*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET /locales — List supported locales
  app.get('/locales', async (c) => {
    const locales = await (db as any)
      .selectFrom('zvd_locales')
      .selectAll()
      .orderBy('is_default', 'desc')
      .orderBy('name', 'asc')
      .execute();
    return c.json({ locales });
  });

  // POST /locales — Add locale
  app.post(
    '/locales',
    zValidator('json', z.object({
      code: z.string().min(2).max(10),
      name: z.string().min(1),
      is_default: z.boolean().default(false),
    })),
    async (c) => {
      const { code, name, is_default } = c.req.valid('json');

      if (is_default) {
        // Unset previous default
        await (db as any)
          .updateTable('zvd_locales')
          .set({ is_default: false })
          .where('is_default', '=', true)
          .execute();
      }

      const locale = await (db as any)
        .insertInto('zvd_locales')
        .values({ code, name, is_default })
        .returningAll()
        .executeTakeFirst();

      return c.json({ locale }, 201);
    },
  );

  // DELETE /locales/:code — Remove locale
  app.delete('/locales/:code', async (c) => {
    const code = c.req.param('code');
    await (db as any)
      .deleteFrom('zvd_locales')
      .where('code', '=', code)
      .execute();
    invalidateCache();
    return c.json({ success: true });
  });

  // ── Admin: Manage translation keys ───────────────────────────

  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET / — List keys with translation status per locale
  app.get('/', async (c) => {
    const { context, search, limit = '50', page = '1' } = c.req.query();
    const lim = Math.min(parseInt(limit), 200);
    const offset = (parseInt(page) - 1) * lim;

    const rows = await sql`
      SELECT
        tk.*,
        COALESCE(
          json_agg(
            json_build_object(
              'locale', t.locale,
              'value', t.value,
              'reviewed', t.reviewed,
              'is_machine_translated', t.is_machine_translated
            )
          ) FILTER (WHERE t.id IS NOT NULL),
          '[]'
        ) AS translations
      FROM zvd_translation_keys tk
      LEFT JOIN zvd_translations t ON t.key_id = tk.id
      WHERE 1=1
        ${context ? sql`AND tk.context = ${context}` : sql``}
        ${search ? sql`AND (tk.key ILIKE ${'%' + search + '%'} OR tk.default_value ILIKE ${'%' + search + '%'})` : sql``}
      GROUP BY tk.id
      ORDER BY tk.key ASC
      LIMIT ${lim} OFFSET ${offset}
    `.execute(db);

    const total = await sql<{ count: string }>`
      SELECT COUNT(*)::int AS count FROM zvd_translation_keys
      WHERE 1=1
        ${context ? sql`AND context = ${context}` : sql``}
        ${search ? sql`AND (key ILIKE ${'%' + search + '%'} OR default_value ILIKE ${'%' + search + '%'})` : sql``}
    `.execute(db);

    return c.json({
      keys: rows.rows,
      pagination: { total: (total.rows[0] as any)?.count ?? 0, page: parseInt(page), limit: lim },
    });
  });

  // POST / — Create translation key
  app.post(
    '/',
    zValidator('json', z.object({
      key: z.string().min(1).max(255),
      context: z.string().optional(),
      default_value: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).default([]),
    })),
    async (c) => {
      const data = c.req.valid('json');
      const existing = await (db as any)
        .selectFrom('zvd_translation_keys')
        .where('key', '=', data.key)
        .executeTakeFirst();

      if (existing) return c.json({ error: `Key '${data.key}' already exists` }, 409);

      const key = await (db as any)
        .insertInto('zvd_translation_keys')
        .values({ ...data, tags: data.tags })
        .returningAll()
        .executeTakeFirst();

      return c.json({ key }, 201);
    },
  );

  // GET /:keyId — Get key with all translations
  app.get('/:keyId', async (c) => {
    const rows = await sql`
      SELECT
        tk.*,
        COALESCE(
          json_agg(
            json_build_object('locale', t.locale, 'value', t.value, 'reviewed', t.reviewed)
          ) FILTER (WHERE t.id IS NOT NULL),
          '[]'
        ) AS translations
      FROM zvd_translation_keys tk
      LEFT JOIN zvd_translations t ON t.key_id = tk.id
      WHERE tk.id = ${c.req.param('keyId')}
      GROUP BY tk.id
    `.execute(db);

    if (!rows.rows[0]) return c.json({ error: 'Key not found' }, 404);
    return c.json({ key: rows.rows[0] });
  });

  // DELETE /:keyId — Delete key and all its translations
  app.delete('/:keyId', async (c) => {
    await (db as any)
      .deleteFrom('zvd_translation_keys')
      .where('id', '=', c.req.param('keyId'))
      .execute();
    invalidateCache();
    return c.json({ success: true });
  });

  // PUT /:keyId/:locale — Set translation value
  app.put(
    '/:keyId/:locale',
    zValidator('json', z.object({
      value: z.string().min(1),
      is_machine_translated: z.boolean().default(false),
      reviewed: z.boolean().default(false),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const { keyId, locale } = c.req.param();
      const data = c.req.valid('json');

      // Verify key exists
      const key = await (db as any)
        .selectFrom('zvd_translation_keys')
        .where('id', '=', keyId)
        .executeTakeFirst();

      if (!key) return c.json({ error: 'Translation key not found' }, 404);

      const translation = await sql`
        INSERT INTO zvd_translations (key_id, locale, value, is_machine_translated, reviewed, updated_by)
        VALUES (${keyId}, ${locale}, ${data.value}, ${data.is_machine_translated}, ${data.reviewed}, ${user.id})
        ON CONFLICT (key_id, locale)
        DO UPDATE SET
          value = EXCLUDED.value,
          is_machine_translated = EXCLUDED.is_machine_translated,
          reviewed = EXCLUDED.reviewed,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
        RETURNING *
      `.execute(db);

      invalidateCache();
      return c.json({ translation: translation.rows[0] });
    },
  );

  // DELETE /:keyId/:locale — Remove translation for a locale
  app.delete('/:keyId/:locale', async (c) => {
    await (db as any)
      .deleteFrom('zvd_translations')
      .where('key_id', '=', c.req.param('keyId'))
      .where('locale', '=', c.req.param('locale'))
      .execute();
    invalidateCache();
    return c.json({ success: true });
  });

  return app;
}
