import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { generateUBLXML } from './ubl-generator.js';

const lineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().default('BUC'),
  unit_price: z.number(),
  vat_rate: z.number().int().min(0).max(25),
  vat_amount: z.number(),
  line_total: z.number(),
});

const invoiceSchema = z.object({
  invoice_number: z.string().min(1),
  invoice_date: z.string(),
  due_date: z.string().optional(),
  seller_name: z.string().min(1),
  seller_cui: z.string().min(1),
  seller_reg_com: z.string().optional(),
  seller_address: z.string().optional(),
  seller_iban: z.string().optional(),
  seller_bank: z.string().optional(),
  buyer_name: z.string().min(1),
  buyer_cui: z.string().optional(),
  buyer_address: z.string().optional(),
  lines: z.array(lineSchema),
  subtotal: z.number(),
  vat_total: z.number(),
  total: z.number(),
  currency: z.string().default('RON'),
});

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

export function efacturaRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  // GET / — list invoices
  app.get('/', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { status, seller_cui } = c.req.query();
    let query = db
      .selectFrom('zv_efactura_invoices')
      .select(['id', 'invoice_number', 'invoice_date', 'buyer_name', 'total', 'currency', 'status', 'anaf_index', 'created_at'])
      .orderBy('invoice_date', 'desc');

    if (status) query = query.where('status', '=', status);
    if (seller_cui) query = query.where('seller_cui', '=', seller_cui);

    const invoices = await query.execute();
    return c.json({ invoices });
  });

  // GET /:id — get invoice
  app.get('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const invoice = await db
      .selectFrom('zv_efactura_invoices')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!invoice) return c.json({ error: 'Invoice not found' }, 404);
    return c.json({ invoice });
  });

  // POST / — create invoice
  app.post('/', zValidator('json', invoiceSchema), async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = c.req.valid('json');
    const invoice = await db
      .insertInto('zv_efactura_invoices')
      .values({
        ...body,
        lines: JSON.stringify(body.lines),
      })
      .returningAll()
      .executeTakeFirst();

    return c.json({ invoice }, 201);
  });

  // PATCH /:id — update draft
  app.patch('/:id', zValidator('json', invoiceSchema.partial()), async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = c.req.valid('json');
    const updates: any = { updated_at: new Date() };
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) updates[k] = k === 'lines' ? JSON.stringify(v) : v;
    }

    const invoice = await db
      .updateTable('zv_efactura_invoices')
      .set(updates)
      .where('id', '=', c.req.param('id'))
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();

    if (!invoice) return c.json({ error: 'Invoice not found or not editable' }, 404);
    return c.json({ invoice });
  });

  app.delete('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db
      .deleteFrom('zv_efactura_invoices')
      .where('id', '=', c.req.param('id'))
      .where('status', '=', 'draft')
      .execute();

    return c.json({ success: true });
  });

  // POST /:id/generate-xml — generate UBL XML
  app.post('/:id/generate-xml', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const invoice = await db
      .selectFrom('zv_efactura_invoices')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!invoice) return c.json({ error: 'Invoice not found' }, 404);

    const lines = typeof invoice.lines === 'string' ? JSON.parse(invoice.lines) : invoice.lines;
    const xml = generateUBLXML({ ...invoice, lines });

    await db
      .updateTable('zv_efactura_invoices')
      .set({ xml_content: xml, status: 'xml_generated', updated_at: new Date() })
      .where('id', '=', invoice.id)
      .execute();

    return c.json({ xml, message: 'UBL XML generated successfully' });
  });

  // GET /:id/xml — download XML
  app.get('/:id/xml', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const invoice = await db
      .selectFrom('zv_efactura_invoices')
      .select(['xml_content', 'invoice_number'])
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!invoice?.xml_content) return c.json({ error: 'XML not generated yet' }, 404);

    return new Response(invoice.xml_content, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="factura_${invoice.invoice_number}.xml"`,
      },
    });
  });

  // POST /:id/submit — submit to ANAF (stub — requires ANAF OAuth token in settings)
  app.post('/:id/submit', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const invoice = await db
      .selectFrom('zv_efactura_invoices')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!invoice) return c.json({ error: 'Invoice not found' }, 404);
    if (!invoice.xml_content) return c.json({ error: 'Generate XML first' }, 400);

    // Stub: in production, call ANAF upload endpoint with OAuth token
    // POST https://api.anaf.ro/prod/FCTEL/rest/upload
    // with the XML as multipart form data
    const mockResponse = {
      dateResponse: new Date().toISOString(),
      ExecutionStatus: '0',
      index_incarcare: `RO${Date.now()}`,
    };

    await db
      .updateTable('zv_efactura_invoices')
      .set({
        status: 'submitted',
        anaf_index: mockResponse.index_incarcare,
        anaf_response: JSON.stringify(mockResponse),
        updated_at: new Date(),
      })
      .where('id', '=', invoice.id)
      .execute();

    return c.json({ message: 'Submitted to ANAF', anaf_index: mockResponse.index_incarcare, response: mockResponse });
  });

  return app;
}
