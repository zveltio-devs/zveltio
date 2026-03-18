import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

const supplierSchema = z.object({
  name: z.string().min(1),
  cui: z.string().min(1),
  reg_com: z.string().optional(),
  address: z.string().optional(),
  county: z.string().optional(),
  iban: z.string().optional(),
  bank: z.string().optional(),
  contact_name: z.string().optional(),
  contact_email: z.string().email().optional(),
  contact_phone: z.string().optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
});

const poItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().default('BUC'),
  unit_price: z.number(),
  total: z.number(),
});

export function roProcurementRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  // ─── Suppliers ─────────────────────────────────────────────────

  app.get('/suppliers', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { search, category } = c.req.query();
    let query = db.selectFrom('zv_ro_suppliers').selectAll().where('is_active', '=', true).orderBy('name', 'asc');
    if (search) query = query.where('name', 'ilike', `%${search}%`);
    if (category) query = query.where('category', '=', category);

    const suppliers = await query.execute();
    return c.json({ suppliers });
  });

  app.post('/suppliers', zValidator('json', supplierSchema), async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = c.req.valid('json');
    const supplier = await db.insertInto('zv_ro_suppliers').values(body).returningAll().executeTakeFirst();
    return c.json({ supplier }, 201);
  });

  app.patch('/suppliers/:id', zValidator('json', supplierSchema.partial()), async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const supplier = await db
      .updateTable('zv_ro_suppliers')
      .set({ ...c.req.valid('json'), updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .returningAll()
      .executeTakeFirst();

    if (!supplier) return c.json({ error: 'Supplier not found' }, 404);
    return c.json({ supplier });
  });

  app.delete('/suppliers/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db.updateTable('zv_ro_suppliers').set({ is_active: false }).where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  // ─── Purchase orders ───────────────────────────────────────────

  app.get('/orders', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { status } = c.req.query();
    let query = db
      .selectFrom('zv_ro_purchase_orders')
      .select(['id', 'number', 'date', 'supplier_name', 'description', 'total', 'currency', 'status', 'budget_line', 'created_at'])
      .orderBy('date', 'desc');

    if (status) query = query.where('status', '=', status);
    const orders = await query.execute();
    return c.json({ orders });
  });

  app.get('/orders/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const order = await db
      .selectFrom('zv_ro_purchase_orders')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!order) return c.json({ error: 'Order not found' }, 404);
    return c.json({ order });
  });

  app.post(
    '/orders',
    zValidator(
      'json',
      z.object({
        number: z.string().min(1),
        date: z.string(),
        supplier_id: z.string().uuid().optional(),
        supplier_name: z.string().min(1),
        supplier_cui: z.string().min(1),
        description: z.string().min(1),
        category: z.string().optional(),
        items: z.array(poItemSchema).default([]),
        subtotal: z.number(),
        vat_total: z.number(),
        total: z.number(),
        currency: z.string().default('RON'),
        budget_line: z.string().optional(),
        notes: z.string().optional(),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const body = c.req.valid('json');
      const order = await db
        .insertInto('zv_ro_purchase_orders')
        .values({ ...body, items: JSON.stringify(body.items), created_by: user.id })
        .returningAll()
        .executeTakeFirst();

      return c.json({ order }, 201);
    },
  );

  // POST /orders/:id/approve
  app.post('/orders/:id/approve', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const order = await db
      .updateTable('zv_ro_purchase_orders')
      .set({ status: 'approved', approved_by: user.id, approved_at: new Date(), updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();

    if (!order) return c.json({ error: 'Order not found or not approvable' }, 404);
    return c.json({ order });
  });

  // POST /orders/:id/receive
  app.post('/orders/:id/receive', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const order = await db
      .updateTable('zv_ro_purchase_orders')
      .set({ status: 'received', received_at: new Date(), updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .where('status', '=', 'approved')
      .returningAll()
      .executeTakeFirst();

    if (!order) return c.json({ error: 'Order not found or not receivable' }, 404);
    return c.json({ order });
  });

  // DELETE /orders/:id
  app.delete('/orders/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db
      .deleteFrom('zv_ro_purchase_orders')
      .where('id', '=', c.req.param('id'))
      .where('status', '=', 'draft')
      .execute();

    return c.json({ success: true });
  });

  // ─── Budget lines ──────────────────────────────────────────────

  app.get('/budget', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { year } = c.req.query();
    let query = db.selectFrom('zv_ro_budget_lines').selectAll().orderBy('code', 'asc');
    if (year) query = query.where('year', '=', parseInt(year, 10));

    const lines = await query.execute();

    // Calculate spent per line
    const spent = await db
      .selectFrom('zv_ro_purchase_orders')
      .select(['budget_line', db.fn.sum('total').as('spent')])
      .where('status', 'in', ['approved', 'received'])
      .groupBy('budget_line')
      .execute();

    const spentMap: Record<string, number> = {};
    for (const s of spent) {
      if (s.budget_line) spentMap[s.budget_line] = Number(s.spent);
    }

    return c.json({
      budget_lines: lines.map((l: any) => ({
        ...l,
        spent: spentMap[l.code] || 0,
        remaining: Number(l.allocated) - (spentMap[l.code] || 0),
      })),
    });
  });

  app.post(
    '/budget',
    zValidator('json', z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      year: z.number().int(),
      allocated: z.number(),
      currency: z.string().default('RON'),
      notes: z.string().optional(),
    })),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const line = await db.insertInto('zv_ro_budget_lines').values(c.req.valid('json')).returningAll().executeTakeFirst();
      return c.json({ budget_line: line }, 201);
    },
  );

  return app;
}
