import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

export function pageBuilderRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  // ─── Block types ───────────────────────────────────────────────

  app.get('/block-types', async (c) => {
    const types = await db
      .selectFrom('zv_page_block_types')
      .selectAll()
      .where('is_active', '=', true)
      .orderBy('display_name', 'asc')
      .execute();
    return c.json({ block_types: types });
  });

  // ─── Pages (admin) ─────────────────────────────────────────────

  app.get('/', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { status, search } = c.req.query();
    let query = db.selectFrom('zv_pages').selectAll().orderBy('updated_at', 'desc');
    if (status) query = query.where('status', '=', status);
    if (search) query = query.where('title', 'ilike', `%${search}%`);

    const pages = await query.execute();
    return c.json({ pages });
  });

  app.get('/:id', async (c) => {
    const page = await db
      .selectFrom('zv_pages')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!page) return c.json({ error: 'Page not found' }, 404);
    return c.json({ page });
  });

  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        title: z.string().min(1),
        slug: z.string().regex(/^[a-z0-9-/]+$/).min(1),
        description: z.string().optional(),
        template: z.string().default('default'),
        blocks: z.array(z.any()).default([]),
        meta: z.record(z.any()).default({}),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const body = c.req.valid('json');
      const page = await db
        .insertInto('zv_pages')
        .values({
          ...body,
          blocks: JSON.stringify(body.blocks),
          meta: JSON.stringify(body.meta),
          created_by: user.id,
          updated_by: user.id,
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ page }, 201);
    },
  );

  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        title: z.string().optional(),
        slug: z.string().optional(),
        description: z.string().optional(),
        template: z.string().optional(),
        blocks: z.array(z.any()).optional(),
        meta: z.record(z.any()).optional(),
        status: z.enum(['draft', 'published', 'archived']).optional(),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const id = c.req.param('id');
      const body = c.req.valid('json');
      const now = new Date();

      // Save revision before update
      const current = await db
        .selectFrom('zv_pages')
        .select(['blocks', 'meta'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (current) {
        await db.insertInto('zv_page_revisions').values({
          page_id: id,
          blocks: current.blocks,
          meta: current.meta,
          created_by: user.id,
        }).execute();
      }

      const updates: any = { updated_at: now, updated_by: user.id };
      if (body.title !== undefined) updates.title = body.title;
      if (body.slug !== undefined) updates.slug = body.slug;
      if (body.description !== undefined) updates.description = body.description;
      if (body.template !== undefined) updates.template = body.template;
      if (body.blocks !== undefined) updates.blocks = JSON.stringify(body.blocks);
      if (body.meta !== undefined) updates.meta = JSON.stringify(body.meta);
      if (body.status !== undefined) {
        updates.status = body.status;
        if (body.status === 'published') updates.published_at = now;
      }

      const page = await db
        .updateTable('zv_pages')
        .set(updates)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();

      if (!page) return c.json({ error: 'Page not found' }, 404);
      return c.json({ page });
    },
  );

  app.delete('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db.deleteFrom('zv_pages').where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  // GET /:id/revisions — page revision history
  app.get('/:id/revisions', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const revisions = await db
      .selectFrom('zv_page_revisions')
      .select(['id', 'created_by', 'created_at'])
      .where('page_id', '=', c.req.param('id'))
      .orderBy('created_at', 'desc')
      .limit(20)
      .execute();

    return c.json({ revisions });
  });

  // ─── Public page renderer ──────────────────────────────────────

  // GET /public/:slug — public page fetch (no auth)
  app.get('/public/:slug', async (c) => {
    const page = await db
      .selectFrom('zv_pages')
      .selectAll()
      .where('slug', '=', c.req.param('slug'))
      .where('status', '=', 'published')
      .executeTakeFirst();

    if (!page) return c.json({ error: 'Page not found' }, 404);
    return c.json({ page });
  });

  return app;
}
