import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../../../packages/engine/src/db/index.js';
import { checkPermission } from '../../../packages/engine/src/lib/permissions.js';
import { UsageTracker } from './lib/usage-tracker.js';
import { handleWebhook, initStripeClient } from './lib/stripe-client.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

export function billingRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Initialize libs
  UsageTracker.init(db);
  initStripeClient(db);

  // Admin middleware for all routes except webhook
  app.use('/usage*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });
  app.use('/plans*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });
  app.use('/subscriptions*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET /usage — usage summary for last 30 days grouped by event_type and day
  app.get('/usage', async (c) => {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const rows = await sql<{ event_type: string; day: string; total: string }>`
      SELECT
        event_type,
        DATE_TRUNC('day', created_at) AS day,
        SUM(quantity)::text AS total
      FROM zv_usage_events
      WHERE created_at >= ${since}
      GROUP BY event_type, DATE_TRUNC('day', created_at)
      ORDER BY day DESC, event_type
    `.execute(db);

    return c.json({ usage: rows.rows });
  });

  // GET /usage/live — last 100 events
  app.get('/usage/live', async (c) => {
    const events = await (db as any)
      .selectFrom('zv_usage_events')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return c.json({ events });
  });

  // GET /plans — list all plans
  app.get('/plans', async (c) => {
    const plans = await (db as any)
      .selectFrom('zv_billing_plans')
      .selectAll()
      .orderBy('price_cents', 'asc')
      .execute();
    return c.json({ plans });
  });

  // POST /plans — create plan
  app.post(
    '/plans',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        stripe_price_id: z.string().optional(),
        limits: z.record(z.number()).default({}),
        price_cents: z.number().int().default(0),
        interval: z.enum(['month', 'year']).default('month'),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      const plan = await (db as any)
        .insertInto('zv_billing_plans')
        .values({
          name: data.name,
          stripe_price_id: data.stripe_price_id ?? null,
          limits: JSON.stringify(data.limits),
          price_cents: data.price_cents,
          interval: data.interval,
        })
        .returningAll()
        .executeTakeFirst();
      return c.json({ plan }, 201);
    },
  );

  // GET /subscriptions — list subscriptions
  app.get('/subscriptions', async (c) => {
    const subs = await (db as any)
      .selectFrom('zv_billing_subscriptions as s')
      .leftJoin('zv_billing_plans as p', 'p.id', 's.plan_id')
      .select([
        's.id', 's.tenant_id', 's.stripe_subscription_id', 's.status',
        's.current_period_start', 's.current_period_end', 's.created_at',
        'p.name as plan_name', 'p.price_cents', 'p.limits',
      ])
      .orderBy('s.created_at', 'desc')
      .execute();
    return c.json({ subscriptions: subs });
  });

  // POST /webhook/stripe — Stripe webhook (no auth, verified by HMAC)
  app.post('/webhook/stripe', async (c) => {
    const signature = c.req.header('stripe-signature') ?? '';
    const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
    if (!secret) {
      return c.json({ error: 'Webhook secret not configured' }, 500);
    }
    const rawBody = await c.req.text();
    const result = await handleWebhook(rawBody, signature, secret);
    if (!result.handled) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ received: true });
  });

  return app;
}
