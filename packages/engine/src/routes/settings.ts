import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';

export function settingsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // GET /public — Public settings (no auth required)
  app.get('/public', async (c) => {
    const settings = await (db as any)
      .selectFrom('zv_settings')
      .selectAll()
      .where('is_public', '=', true)
      .execute();

    const result: Record<string, any> = {};
    for (const s of settings) {
      result[(s as any).key] = typeof (s as any).value === 'string'
        ? JSON.parse((s as any).value)
        : (s as any).value;
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
      result[(s as any).key] = typeof (s as any).value === 'string'
        ? JSON.parse((s as any).value)
        : (s as any).value;
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

    return c.json({
      key: (setting as any).key,
      value: typeof (setting as any).value === 'string'
        ? JSON.parse((setting as any).value)
        : (setting as any).value,
    });
  });

  // PUT /:key — Upsert a setting
  app.put(
    '/:key',
    zValidator('json', z.object({ value: z.any(), is_public: z.boolean().optional() })),
    async (c) => {
      const key = c.req.param('key');
      const { value, is_public } = c.req.valid('json');
      const serialized = JSON.stringify(value);

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
    for (const [key, value] of Object.entries(body)) {
      const serialized = JSON.stringify(value);
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
