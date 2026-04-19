/**
 * Bundled extension: content/page-builder
 *
 * Visual CMS page builder with blocks, SEO fields, and publish workflow.
 * Routes mounted at /api/ext/pages by the engine bootstrap.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';

// ── Migration ──────────────────────────────────────────────────────────────────

export async function migratePageBuilder(db: Database): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS zvd_ext_pages (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title            TEXT NOT NULL,
      slug             TEXT NOT NULL UNIQUE,
      blocks           JSONB NOT NULL DEFAULT '[]',
      meta_title       TEXT,
      meta_description TEXT,
      status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      created_by       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at     TIMESTAMPTZ
    )
  `.execute(db);
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const BlockSchema = z.object({
  type:    z.string().min(1),
  content: z.record(z.string(), z.unknown()),
});

const PageCreateSchema = z.object({
  title:            z.string().min(1).max(300),
  slug:             z.string().min(1).max(200).regex(/^[a-z0-9-/]+$/),
  blocks:           z.array(BlockSchema).default([]),
  meta_title:       z.string().max(200).optional(),
  meta_description: z.string().max(500).optional(),
  status:           z.enum(['draft', 'published']).optional(),
});

// ── Route factory ──────────────────────────────────────────────────────────────

export function registerPageBuilder(app: Hono, db: Database): void {
  const router = new Hono();

  // Auth middleware
  router.use('*', async (c, next) => {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        const row = await (db as any)
          .selectFrom('user')
          .select(['role'])
          .where('id', '=', session.user.id)
          .executeTakeFirst();
        c.set('user', { ...session.user, role: row?.role ?? (session.user as any).role });
      }
    } catch { /* no-op */ }
    await next();
  });

  async function requireAdmin(c: any): Promise<boolean> {
    const user = c.get('user');
    if (!user) return false;
    return checkPermission(user.id, 'admin', '*').catch(() => false);
  }

  // GET /api/ext/pages
  router.get('/', async (c) => {
    if (!await requireAdmin(c)) return c.json({ error: 'Admin required' }, 403);
    const rows = await (db as any)
      .selectFrom('zvd_ext_pages')
      .selectAll()
      .orderBy('updated_at', 'desc')
      .execute();
    return c.json({ pages: rows });
  });

  // POST /api/ext/pages
  router.post('/', zValidator('json', PageCreateSchema), async (c) => {
    if (!await requireAdmin(c)) return c.json({ error: 'Admin required' }, 403);
    const data = c.req.valid('json');
    const user = c.get('user');
    const isPublished = data.status === 'published';
    const row = await (db as any)
      .insertInto('zvd_ext_pages')
      .values({
        title:            data.title,
        slug:             data.slug,
        blocks:           JSON.stringify(data.blocks),
        meta_title:       data.meta_title ?? null,
        meta_description: data.meta_description ?? null,
        status:           data.status ?? 'draft',
        created_by:       user?.id ?? null,
        published_at:     isPublished ? new Date() : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return c.json({ page: row }, 201);
  });

  // GET /api/ext/pages/:id
  router.get('/:id', async (c) => {
    if (!await requireAdmin(c)) return c.json({ error: 'Admin required' }, 403);
    const row = await (db as any)
      .selectFrom('zvd_ext_pages')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ page: row });
  });

  // GET /api/ext/pages/by-slug/:slug — public endpoint
  router.get('/by-slug/:slug', async (c) => {
    const row = await (db as any)
      .selectFrom('zvd_ext_pages')
      .selectAll()
      .where('slug', '=', c.req.param('slug'))
      .where('status', '=', 'published')
      .executeTakeFirst();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ page: row });
  });

  // PUT /api/ext/pages/:id
  router.put('/:id', zValidator('json', PageCreateSchema.partial()), async (c) => {
    if (!await requireAdmin(c)) return c.json({ error: 'Admin required' }, 403);
    const data = c.req.valid('json');
    const update: any = { ...data, updated_at: new Date() };
    if (data.blocks !== undefined) update.blocks = JSON.stringify(data.blocks);
    if (data.status === 'published') update.published_at = new Date();
    const row = await (db as any)
      .updateTable('zvd_ext_pages')
      .set(update)
      .where('id', '=', c.req.param('id'))
      .returningAll()
      .executeTakeFirst();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ page: row });
  });

  // DELETE /api/ext/pages/:id
  router.delete('/:id', async (c) => {
    if (!await requireAdmin(c)) return c.json({ error: 'Admin required' }, 403);
    await (db as any)
      .deleteFrom('zvd_ext_pages')
      .where('id', '=', c.req.param('id'))
      .execute();
    return c.json({ success: true });
  });

  app.route('/api/ext/pages', router);
}
