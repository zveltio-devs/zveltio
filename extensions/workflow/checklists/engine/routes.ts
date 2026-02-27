import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export function checklistsRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  async function getUser(c: any) {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return session?.user ?? null;
  }

  // ─── Templates ────────────────────────────────────────────────

  app.get('/templates', async (c) => {
    const { collection } = c.req.query();
    let query = db.selectFrom('zv_checklist_templates').selectAll().where('is_active', '=', true);
    if (collection) {
      query = query.where((eb: any) =>
        eb.or([eb('collection', '=', collection), eb('collection', 'is', null)])
      );
    }
    const templates = await query.orderBy('name', 'asc').execute();
    return c.json({ templates });
  });

  app.post(
    '/templates',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        collection: z.string().optional(),
        items: z.array(
          z.object({
            label: z.string().min(1),
            description: z.string().optional(),
            required: z.boolean().default(false),
            order_idx: z.number().default(0),
          })
        ).default([]),
      })
    ),
    async (c) => {
      const user = await getUser(c);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const { name, description, collection, items } = c.req.valid('json');
      const template = await db
        .insertInto('zv_checklist_templates')
        .values({ name, description, collection: collection || null })
        .returningAll()
        .executeTakeFirst();

      if (items.length > 0) {
        await db.insertInto('zv_checklist_template_items')
          .values(items.map((item: any, i: number) => ({
            template_id: template.id,
            label: item.label,
            description: item.description,
            required: item.required,
            order_idx: item.order_idx ?? i,
          })))
          .execute();
      }

      const templateItems = await db
        .selectFrom('zv_checklist_template_items')
        .selectAll()
        .where('template_id', '=', template.id)
        .orderBy('order_idx', 'asc')
        .execute();

      return c.json({ template: { ...template, items: templateItems } }, 201);
    }
  );

  app.delete('/templates/:id', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db.updateTable('zv_checklist_templates')
      .set({ is_active: false })
      .where('id', '=', c.req.param('id'))
      .execute();

    return c.json({ success: true });
  });

  // ─── Checklist instances ───────────────────────────────────────

  // GET /record/:collection/:recordId — get all checklists for a record
  app.get('/record/:collection/:recordId', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { collection, recordId } = c.req.param();

    const checklists = await db
      .selectFrom('zv_checklists')
      .selectAll()
      .where('collection', '=', collection)
      .where('record_id', '=', recordId)
      .orderBy('created_at', 'asc')
      .execute();

    const withItems = await Promise.all(
      checklists.map(async (cl: any) => {
        const items = await db
          .selectFrom('zv_checklist_items')
          .selectAll()
          .where('checklist_id', '=', cl.id)
          .orderBy('order_idx', 'asc')
          .execute();
        return { ...cl, items };
      })
    );

    return c.json({ checklists: withItems });
  });

  // POST /record/:collection/:recordId — attach a checklist (from template or custom)
  app.post(
    '/record/:collection/:recordId',
    zValidator(
      'json',
      z.object({
        template_id: z.string().uuid().optional(),
        name: z.string().min(1),
        items: z.array(
          z.object({
            label: z.string().min(1),
            description: z.string().optional(),
            required: z.boolean().default(false),
            order_idx: z.number().default(0),
          })
        ).optional(),
      })
    ),
    async (c) => {
      const user = await getUser(c);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const { collection, recordId } = c.req.param();
      const { template_id, name, items: customItems } = c.req.valid('json');

      const checklist = await db
        .insertInto('zv_checklists')
        .values({
          template_id: template_id || null,
          collection,
          record_id: recordId,
          name,
          created_by: user.id,
        })
        .returningAll()
        .executeTakeFirst();

      // Resolve items from template or custom
      let itemsToInsert: any[] = [];
      if (template_id) {
        itemsToInsert = await db
          .selectFrom('zv_checklist_template_items')
          .selectAll()
          .where('template_id', '=', template_id)
          .orderBy('order_idx', 'asc')
          .execute();
      } else if (customItems) {
        itemsToInsert = customItems;
      }

      if (itemsToInsert.length > 0) {
        await db.insertInto('zv_checklist_items')
          .values(itemsToInsert.map((item: any, i: number) => ({
            checklist_id: checklist.id,
            label: item.label,
            description: item.description,
            required: item.required ?? false,
            order_idx: item.order_idx ?? i,
          })))
          .execute();
      }

      const items = await db
        .selectFrom('zv_checklist_items')
        .selectAll()
        .where('checklist_id', '=', checklist.id)
        .orderBy('order_idx', 'asc')
        .execute();

      return c.json({ checklist: { ...checklist, items } }, 201);
    }
  );

  // PATCH /items/:itemId — check/uncheck an item
  app.patch(
    '/items/:itemId',
    zValidator('json', z.object({ checked: z.boolean() })),
    async (c) => {
      const user = await getUser(c);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const { checked } = c.req.valid('json');
      const now = new Date();

      const item = await db
        .updateTable('zv_checklist_items')
        .set({
          checked,
          checked_by: checked ? user.id : null,
          checked_at: checked ? now : null,
        })
        .where('id', '=', c.req.param('itemId'))
        .returningAll()
        .executeTakeFirst();

      if (!item) return c.json({ error: 'Item not found' }, 404);

      // Auto-complete checklist if all required items are checked
      const allItems = await db
        .selectFrom('zv_checklist_items')
        .selectAll()
        .where('checklist_id', '=', item.checklist_id)
        .execute();

      const allRequiredChecked = allItems
        .filter((i: any) => i.required)
        .every((i: any) => i.checked);

      if (allRequiredChecked) {
        await db
          .updateTable('zv_checklists')
          .set({ completed_at: now, updated_at: now })
          .where('id', '=', item.checklist_id)
          .where('completed_at', 'is', null)
          .execute();
      } else {
        await db
          .updateTable('zv_checklists')
          .set({ completed_at: null, updated_at: now })
          .where('id', '=', item.checklist_id)
          .execute();
      }

      return c.json({ item });
    }
  );

  // GET /summary — overview of recent checklists across all records
  app.get('/summary', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { limit: lim = '20' } = c.req.query();

    const checklists = await db
      .selectFrom('zv_checklists')
      .selectAll()
      .orderBy('updated_at', 'desc')
      .limit(parseInt(lim))
      .execute();

    const withProgress = await Promise.all(
      checklists.map(async (cl: any) => {
        const items = await db
          .selectFrom('zv_checklist_items')
          .selectAll()
          .where('checklist_id', '=', cl.id)
          .execute();
        const total = items.length;
        const checked = items.filter((i: any) => i.checked).length;
        return { ...cl, total_items: total, checked_items: checked, progress: total > 0 ? Math.round((checked / total) * 100) : 0 };
      })
    );

    const stats = {
      total: checklists.length,
      completed: checklists.filter((cl: any) => cl.completed_at).length,
      in_progress: checklists.filter((cl: any) => !cl.completed_at).length,
    };

    return c.json({ checklists: withProgress, stats });
  });

  // DELETE /:id — delete checklist instance
  app.delete('/:id', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db.deleteFrom('zv_checklists').where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  return app;
}
