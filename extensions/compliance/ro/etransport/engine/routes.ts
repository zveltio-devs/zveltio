import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

const goodSchema = z.object({
  tariff_code: z.string().min(1),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().default('BUC'),
  weight_kg: z.number().min(0),
});

const declarationSchema = z.object({
  transport_date: z.string().min(1),
  vehicle_plate: z.string().min(1),
  driver_name: z.string().min(1),
  driver_cnp: z.string().optional(),
  departure_address: z.string().min(1),
  departure_county: z.string().min(1),
  departure_country: z.string().default('RO'),
  destination_address: z.string().min(1),
  destination_county: z.string().min(1),
  destination_country: z.string().default('RO'),
  goods: z.array(goodSchema).default([]),
  total_weight_kg: z.number().min(0).default(0),
  purpose: z.enum(['commercial', 'personal', 'return']).default('commercial'),
});

export function etransportRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { status, from, to } = c.req.query();
    let query = db
      .selectFrom('zv_etransport_declarations')
      .select(['id', 'uit', 'transport_date', 'vehicle_plate', 'driver_name',
               'departure_county', 'destination_county', 'total_weight_kg',
               'purpose', 'status', 'created_at'])
      .orderBy('transport_date', 'desc');

    if (status) query = query.where('status', '=', status);
    if (from) query = query.where('transport_date', '>=', from);
    if (to) query = query.where('transport_date', '<=', to);

    const declarations = await query.execute();
    return c.json({ declarations });
  });

  app.get('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const decl = await db
      .selectFrom('zv_etransport_declarations')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!decl) return c.json({ error: 'Declaration not found' }, 404);
    const goods = typeof decl.goods === 'string' ? JSON.parse(decl.goods) : decl.goods;
    return c.json({ declaration: { ...decl, goods } });
  });

  app.post('/', zValidator('json', declarationSchema), async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = c.req.valid('json');
    const decl = await db
      .insertInto('zv_etransport_declarations')
      .values({ ...body, goods: JSON.stringify(body.goods) })
      .returningAll()
      .executeTakeFirst();

    return c.json({ declaration: decl }, 201);
  });

  app.patch('/:id', zValidator('json', declarationSchema.partial()), async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = c.req.valid('json');
    const updates: any = { updated_at: new Date() };
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) updates[k] = k === 'goods' ? JSON.stringify(v) : v;
    }

    const decl = await db
      .updateTable('zv_etransport_declarations')
      .set(updates)
      .where('id', '=', c.req.param('id'))
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();

    if (!decl) return c.json({ error: 'Declaration not found or not editable' }, 404);
    return c.json({ declaration: decl });
  });

  app.delete('/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db
      .deleteFrom('zv_etransport_declarations')
      .where('id', '=', c.req.param('id'))
      .where('status', '=', 'draft')
      .execute();

    return c.json({ success: true });
  });

  app.post('/:id/declare', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const decl = await db
      .selectFrom('zv_etransport_declarations')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!decl) return c.json({ error: 'Declaration not found' }, 404);
    if (decl.status !== 'draft') return c.json({ error: 'Only draft declarations can be declared' }, 400);

    // Stub: in production call ANAF e-Transport API
    const uit = `RO${Date.now()}`;
    const anafResponse = {
      dateResponse: new Date().toISOString(),
      ExecutionStatus: '0',
      UIT: uit,
    };

    await db
      .updateTable('zv_etransport_declarations')
      .set({ uit, status: 'declared', anaf_response: JSON.stringify(anafResponse), updated_at: new Date() })
      .where('id', '=', decl.id)
      .execute();

    return c.json({ message: 'Declaration submitted to ANAF', uit, response: anafResponse });
  });

  app.post('/:id/complete', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db
      .updateTable('zv_etransport_declarations')
      .set({ status: 'completed', updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .where('status', 'in', ['declared', 'in_transit'])
      .execute();

    return c.json({ success: true });
  });

  app.post('/:id/cancel', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db
      .updateTable('zv_etransport_declarations')
      .set({ status: 'cancelled', updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .where('status', 'not in', ['completed', 'cancelled'])
      .execute();

    return c.json({ success: true });
  });

  return app;
}
