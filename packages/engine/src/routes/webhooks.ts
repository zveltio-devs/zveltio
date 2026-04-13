import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { safeFetch, validatePublicUrl } from '../lib/edge-functions/safe-fetch.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

const WebhookSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string(), z.string()).default({}),
  events: z.array(z.string()).min(1),
  collections: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  secret: z.string().optional(),
  retry_attempts: z.number().int().min(0).max(10).default(3),
  timeout: z.number().int().min(1000).max(30000).default(5000),
});

export function webhooksRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  /** Replace secret with a masked indicator — never expose plaintext secrets via API. */
  function maskSecret(webhook: any): any {
    if (!webhook) return webhook;
    return { ...webhook, secret: webhook.secret ? '••••••••' : null };
  }

  // GET / — List all webhooks
  app.get('/', async (c) => {
    const webhooks = await (db as any)
      .selectFrom('zvd_webhooks')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return c.json({ webhooks: webhooks.map(maskSecret) });
  });

  // GET /:id — Get webhook
  app.get('/:id', async (c) => {
    const webhook = await (db as any)
      .selectFrom('zvd_webhooks')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();
    if (!webhook) return c.json({ error: 'Webhook not found' }, 404);
    return c.json({ webhook: maskSecret(webhook) });
  });

  // POST / — Create webhook
  app.post('/', zValidator('json', WebhookSchema), async (c) => {
    const user = c.get('user') as any;
    const data = c.req.valid('json');

    // SSRF protection: reject URLs targeting internal/private networks
    try {
      validatePublicUrl(data.url);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid webhook URL' }, 400);
    }

    const webhook = await (db as any)
      .insertInto('zvd_webhooks')
      .values({ ...data, created_by: user.id })
      .returningAll()
      .executeTakeFirst();

    return c.json(webhook);
  });

  // PATCH /:id — Update webhook
  app.patch('/:id', zValidator('json', WebhookSchema.partial()), async (c) => {
    const data = c.req.valid('json');
    // SSRF protection on URL update
    if (data.url) {
      try {
        validatePublicUrl(data.url);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Invalid webhook URL' }, 400);
      }
    }
    const webhook = await (db as any)
      .updateTable('zvd_webhooks')
      .set({ ...data, updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .returningAll()
      .executeTakeFirst();

    if (!webhook) return c.json({ error: 'Webhook not found' }, 404);
    return c.json({ webhook });
  });

  // DELETE /:id — Delete webhook
  app.delete('/:id', async (c) => {
    const result = await (db as any)
      .deleteFrom('zvd_webhooks')
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();
    if (!result) return c.json({ error: 'Webhook not found' }, 404);
    return c.json({ success: true });
  });

  // GET /:id/deliveries — Delivery logs
  app.get('/:id/deliveries', async (c) => {
    const { limit = '50' } = c.req.query();
    const deliveries = await (db as any)
      .selectFrom('zvd_webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', c.req.param('id'))
      .orderBy('created_at', 'desc')
      .limit(Math.min(parseInt(limit) || 50, 500))
      .execute();
    return c.json({ deliveries });
  });

  // POST /:id/test — Test webhook
  app.post('/:id/test', async (c) => {
    const webhook = await (db as any)
      .selectFrom('zvd_webhooks')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!webhook) return c.json({ error: 'Webhook not found' }, 404);

    try {
      // Security: sanitize stored headers — block credential injection.
      const BLOCKED_HEADERS = new Set([
        'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token',
        'x-forwarded-for', 'x-real-ip', 'x-zveltio-internal', 'host', 'origin', 'referer',
      ]);
      const sanitizedHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      for (const [key, value] of Object.entries((webhook.headers as Record<string, string>) || {})) {
        if (!BLOCKED_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
          sanitizedHeaders[key] = value;
        }
      }

      validatePublicUrl(webhook.url as string);
      const response = await safeFetch(webhook.url as string, {
        method: (webhook.method as string) || 'POST',
        headers: sanitizedHeaders,
        body: JSON.stringify({
          event: 'test',
          collection: 'test',
          data: { message: 'Test webhook from Zveltio' },
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(webhook.timeout || 5000),
      });

      return c.json({
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (err) {
      return c.json({
        success: false,
        error: err instanceof Error ? err.message : 'Request failed',
      });
    }
  });

  return app;
}
