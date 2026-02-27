import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

const DOC_TYPES = ['contract', 'pv', 'nir', 'dispozitie_plata', 'proces_verbal', 'notificare', 'other'] as const;

export function roDocumentsRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  // GET /templates
  app.get('/templates', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const templates = await db
      .selectFrom('zv_ro_document_templates')
      .select(['id', 'name', 'type', 'description', 'variables'])
      .where('is_active', '=', true)
      .orderBy('name', 'asc')
      .execute();

    return c.json({ templates });
  });

  // GET / — list documents
  app.get('/', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { type, status } = c.req.query();
    let query = db
      .selectFrom('zv_ro_documents')
      .select(['id', 'type', 'number', 'date', 'title', 'status', 'signed_at', 'created_at'])
      .orderBy('date', 'desc');

    if (type) query = query.where('type', '=', type);
    if (status) query = query.where('status', '=', status);

    const documents = await query.execute();
    return c.json({ documents });
  });

  // GET /:id
  app.get('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const doc = await db
      .selectFrom('zv_ro_documents')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!doc) return c.json({ error: 'Document not found' }, 404);
    return c.json({ document: doc });
  });

  // POST /
  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        type: z.enum(DOC_TYPES),
        number: z.string().min(1),
        date: z.string(),
        title: z.string().min(1),
        parties: z.array(z.object({ name: z.string(), cui: z.string().optional(), role: z.string() })).default([]),
        content: z.string().optional(),
        template_id: z.string().optional(),
        metadata: z.record(z.any()).default({}),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const body = c.req.valid('json');
      const doc = await db
        .insertInto('zv_ro_documents')
        .values({
          ...body,
          parties: JSON.stringify(body.parties),
          metadata: JSON.stringify(body.metadata),
          created_by: user.id,
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ document: doc }, 201);
    },
  );

  // PATCH /:id/sign — mark as signed
  app.patch('/:id/sign', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const doc = await db
      .updateTable('zv_ro_documents')
      .set({ status: 'signed', signed_at: new Date(), updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .returningAll()
      .executeTakeFirst();

    if (!doc) return c.json({ error: 'Document not found' }, 404);
    return c.json({ document: doc });
  });

  // DELETE /:id
  app.delete('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db
      .deleteFrom('zv_ro_documents')
      .where('id', '=', c.req.param('id'))
      .where('status', '=', 'draft')
      .execute();

    return c.json({ success: true });
  });

  return app;
}
