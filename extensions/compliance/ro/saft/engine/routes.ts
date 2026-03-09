import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { generateSAFTXML } from './saft-generator.js';

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

const exportSchema = z.object({
  period_start: z.string().min(1),
  period_end: z.string().min(1),
  company_name: z.string().min(1),
  company_cui: z.string().min(1),
  company_address: z.string().optional(),
});

const accountSchema = z.object({
  code: z.string().min(1),
  description: z.string().min(1),
  account_type: z.enum(['balance', 'income', 'expense']).default('balance'),
});

const entrySchema = z.object({
  account_code: z.string().min(1),
  entry_date: z.string().min(1),
  description: z.string().min(1),
  debit: z.number().min(0).default(0),
  credit: z.number().min(0).default(0),
  document_number: z.string().optional(),
});

export function saftRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  // --- Exports ---

  app.get('/', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const exports = await db
      .selectFrom('zv_saft_exports')
      .select(['id', 'period_start', 'period_end', 'company_name', 'company_cui', 'status', 'created_at'])
      .orderBy('period_start', 'desc')
      .execute();

    return c.json({ exports });
  });

  app.get('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const exp = await db
      .selectFrom('zv_saft_exports')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!exp) return c.json({ error: 'Export not found' }, 404);
    return c.json({ export: exp });
  });

  app.post('/', zValidator('json', exportSchema), async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = c.req.valid('json');
    const exp = await db
      .insertInto('zv_saft_exports')
      .values(body)
      .returningAll()
      .executeTakeFirst();

    return c.json({ export: exp }, 201);
  });

  app.delete('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db
      .deleteFrom('zv_saft_exports')
      .where('id', '=', c.req.param('id'))
      .where('status', '=', 'draft')
      .execute();

    return c.json({ success: true });
  });

  app.post('/:id/generate', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const exp = await db
      .selectFrom('zv_saft_exports')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!exp) return c.json({ error: 'Export not found' }, 404);

    const accounts = await db
      .selectFrom('zv_saft_accounts')
      .selectAll()
      .orderBy('code', 'asc')
      .execute();

    const entries = await db
      .selectFrom('zv_saft_journal_entries')
      .selectAll()
      .where('entry_date', '>=', exp.period_start)
      .where('entry_date', '<=', exp.period_end)
      .orderBy('entry_date', 'asc')
      .execute();

    const xml = generateSAFTXML({
      company_name: exp.company_name,
      company_cui: exp.company_cui,
      company_address: exp.company_address,
      period_start: exp.period_start,
      period_end: exp.period_end,
      accounts,
      entries,
    });

    await db
      .updateTable('zv_saft_exports')
      .set({ xml_content: xml, status: 'generated', updated_at: new Date() })
      .where('id', '=', exp.id)
      .execute();

    return c.json({ message: 'SAF-T XML generated', entries_count: entries.length });
  });

  app.get('/:id/xml', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const exp = await db
      .selectFrom('zv_saft_exports')
      .select(['xml_content', 'period_start', 'period_end', 'company_cui'])
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!exp?.xml_content) return c.json({ error: 'XML not generated yet' }, 404);

    return new Response(exp.xml_content, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="SAFT_${exp.company_cui}_${exp.period_start}_${exp.period_end}.xml"`,
      },
    });
  });

  app.post('/:id/submit', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const exp = await db
      .selectFrom('zv_saft_exports')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!exp) return c.json({ error: 'Export not found' }, 404);
    if (!exp.xml_content) return c.json({ error: 'Generate XML first' }, 400);

    const mockResponse = {
      dateResponse: new Date().toISOString(),
      ExecutionStatus: '0',
      index_incarcare: `SAFT${Date.now()}`,
    };

    await db
      .updateTable('zv_saft_exports')
      .set({ status: 'submitted', anaf_response: JSON.stringify(mockResponse), updated_at: new Date() })
      .where('id', '=', exp.id)
      .execute();

    return c.json({ message: 'Submitted to ANAF', response: mockResponse });
  });

  // --- Accounts ---

  app.get('/accounts', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const accounts = await db
      .selectFrom('zv_saft_accounts')
      .selectAll()
      .orderBy('code', 'asc')
      .execute();

    return c.json({ accounts });
  });

  app.post('/accounts', zValidator('json', accountSchema), async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = c.req.valid('json');
    const account = await db
      .insertInto('zv_saft_accounts')
      .values(body)
      .returningAll()
      .executeTakeFirst();

    return c.json({ account }, 201);
  });

  app.delete('/accounts/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db.deleteFrom('zv_saft_accounts').where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  // --- Journal Entries ---

  app.get('/entries', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { from, to, account_code } = c.req.query();
    let query = db.selectFrom('zv_saft_journal_entries').selectAll();
    if (from) query = query.where('entry_date', '>=', from);
    if (to) query = query.where('entry_date', '<=', to);
    if (account_code) query = query.where('account_code', '=', account_code);

    const entries = await query.orderBy('entry_date', 'desc').execute();
    return c.json({ entries });
  });

  app.post('/entries', zValidator('json', entrySchema), async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = c.req.valid('json');
    const entry = await db
      .insertInto('zv_saft_journal_entries')
      .values(body)
      .returningAll()
      .executeTakeFirst();

    return c.json({ entry }, 201);
  });

  app.delete('/entries/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db.deleteFrom('zv_saft_journal_entries').where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  return app;
}
