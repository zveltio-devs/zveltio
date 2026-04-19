/**
 * Bundled extension: workflow/checklists
 *
 * Provides dynamic checklists (templates) and response tracking.
 * Routes mounted at /api/ext/checklists by the engine bootstrap.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';

// ── Migration ──────────────────────────────────────────────────────────────────

export async function migrateChecklists(db: Database): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS zvd_ext_checklists (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name         TEXT NOT NULL,
      description  TEXT,
      items        JSONB NOT NULL DEFAULT '[]',
      is_active    BOOLEAN NOT NULL DEFAULT true,
      created_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS zvd_ext_checklist_responses (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      checklist_id  UUID NOT NULL REFERENCES zvd_ext_checklists(id) ON DELETE CASCADE,
      submitted_by  TEXT,
      answers       JSONB NOT NULL DEFAULT '{}',
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}

// ── Schemas ────────────────────────────────────────────────────────────────────

const ChecklistItemSchema = z.object({
  id:       z.string().min(1),
  text:     z.string().min(1),
  required: z.boolean().optional(),
});

const ChecklistCreateSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  items:       z.array(ChecklistItemSchema).default([]),
  is_active:   z.boolean().optional(),
});

const ResponseSubmitSchema = z.object({
  answers: z.record(z.string(), z.union([z.boolean(), z.string()])),
  notes:   z.string().max(2000).optional(),
});

// ── Route factory ──────────────────────────────────────────────────────────────

export function registerChecklists(app: Hono, db: Database): void {
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

  async function requireAuth(c: any): Promise<boolean> {
    const user = c.get('user');
    return !!user;
  }

  async function requireAdmin(c: any): Promise<boolean> {
    const user = c.get('user');
    if (!user) return false;
    return checkPermission(user.id, 'admin', '*').catch(() => false);
  }

  // GET /api/ext/checklists
  router.get('/', async (c) => {
    if (!await requireAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    const rows = await (db as any)
      .selectFrom('zvd_ext_checklists')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return c.json({ checklists: rows });
  });

  // POST /api/ext/checklists
  router.post('/', zValidator('json', ChecklistCreateSchema), async (c) => {
    if (!await requireAdmin(c)) return c.json({ error: 'Admin required' }, 403);
    const data = c.req.valid('json');
    const user = c.get('user');
    const row = await (db as any)
      .insertInto('zvd_ext_checklists')
      .values({
        name:        data.name,
        description: data.description ?? null,
        items:       JSON.stringify(data.items),
        is_active:   data.is_active ?? true,
        created_by:  user?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return c.json({ checklist: row }, 201);
  });

  // GET /api/ext/checklists/:id
  router.get('/:id', async (c) => {
    if (!await requireAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    const row = await (db as any)
      .selectFrom('zvd_ext_checklists')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ checklist: row });
  });

  // PUT /api/ext/checklists/:id
  router.put('/:id', zValidator('json', ChecklistCreateSchema.partial()), async (c) => {
    if (!await requireAdmin(c)) return c.json({ error: 'Admin required' }, 403);
    const data = c.req.valid('json');
    const update: any = { ...data, updated_at: new Date() };
    if (data.items !== undefined) update.items = JSON.stringify(data.items);
    const row = await (db as any)
      .updateTable('zvd_ext_checklists')
      .set(update)
      .where('id', '=', c.req.param('id'))
      .returningAll()
      .executeTakeFirst();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ checklist: row });
  });

  // DELETE /api/ext/checklists/:id
  router.delete('/:id', async (c) => {
    if (!await requireAdmin(c)) return c.json({ error: 'Admin required' }, 403);
    await (db as any)
      .deleteFrom('zvd_ext_checklists')
      .where('id', '=', c.req.param('id'))
      .execute();
    return c.json({ success: true });
  });

  // GET /api/ext/checklists/:id/responses
  router.get('/:id/responses', async (c) => {
    if (!await requireAdmin(c)) return c.json({ error: 'Admin required' }, 403);
    const rows = await (db as any)
      .selectFrom('zvd_ext_checklist_responses')
      .selectAll()
      .where('checklist_id', '=', c.req.param('id'))
      .orderBy('created_at', 'desc')
      .execute();
    return c.json({ responses: rows });
  });

  // POST /api/ext/checklists/:id/responses
  router.post('/:id/responses', zValidator('json', ResponseSubmitSchema), async (c) => {
    if (!await requireAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
    const data = c.req.valid('json');
    const user = c.get('user');
    const row = await (db as any)
      .insertInto('zvd_ext_checklist_responses')
      .values({
        checklist_id: c.req.param('id'),
        submitted_by: user?.id ?? null,
        answers:      JSON.stringify(data.answers),
        notes:        data.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return c.json({ response: row }, 201);
  });

  app.route('/api/ext/checklists', router);
}
