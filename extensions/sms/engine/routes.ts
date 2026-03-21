import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../../../packages/engine/src/db/index.js';
import { checkPermission } from '../../../packages/engine/src/lib/permissions.js';
import { SmsManager } from './lib/sms-manager.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

export function smsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Initialize manager
  SmsManager.init(db);

  // Admin middleware for all except webhook
  app.use('/send', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });
  app.use('/messages*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });
  app.use('/templates*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });
  app.use('/stats', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // POST /send — send SMS immediately
  app.post(
    '/send',
    zValidator(
      'json',
      z.object({
        provider: z.enum(['twilio', 'vonage']).default('twilio'),
        to: z.string().min(1),
        body: z.string().optional(),
        template_id: z.string().uuid().optional(),
        variables: z.record(z.string()).optional(),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      try {
        const result = await SmsManager.send(data);
        return c.json({ success: true, ...result }, 201);
      } catch (err: any) {
        return c.json({ error: err.message ?? 'Send failed' }, 500);
      }
    },
  );

  // GET /messages — list with pagination + filter
  app.get('/messages', async (c) => {
    const { page = '1', limit = '50', status } = c.req.query();
    const parsedLimit = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * parsedLimit;

    let query = (db as any)
      .selectFrom('zv_sms_messages')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(parsedLimit)
      .offset(offset);

    if (status) query = query.where('status', '=', status);

    const messages = await query.execute();
    return c.json({ messages });
  });

  // GET /templates — list templates
  app.get('/templates', async (c) => {
    const templates = await (db as any)
      .selectFrom('zv_sms_templates')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return c.json({ templates });
  });

  // POST /templates — create template
  app.post(
    '/templates',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        body: z.string().min(1),
        provider: z.enum(['twilio', 'vonage']).default('twilio'),
      }),
    ),
    async (c) => {
      const data = c.req.valid('json');
      const template = await (db as any)
        .insertInto('zv_sms_templates')
        .values(data)
        .returningAll()
        .executeTakeFirst();
      return c.json({ template }, 201);
    },
  );

  // POST /webhook/twilio — receive delivery status from Twilio
  app.post('/webhook/twilio', async (c) => {
    const body = await c.req.formData().catch(() => null);
    if (!body) return c.json({ error: 'Invalid form data' }, 400);

    const messageSid = body.get('MessageSid') as string | null;
    const messageStatus = body.get('MessageStatus') as string | null;

    if (!messageSid || !messageStatus) {
      return c.json({ error: 'Missing MessageSid or MessageStatus' }, 400);
    }

    // Map Twilio status to our status
    const statusMap: Record<string, string> = {
      delivered: 'delivered',
      failed: 'failed',
      undelivered: 'failed',
      sent: 'sent',
      queued: 'pending',
      sending: 'pending',
    };
    const mappedStatus = statusMap[messageStatus] ?? messageStatus;

    await (db as any)
      .updateTable('zv_sms_messages')
      .set({ status: mappedStatus })
      .where('provider_message_id', '=', messageSid)
      .execute();

    return c.text('OK');
  });

  // GET /stats — counts by status last 7 days
  app.get('/stats', async (c) => {
    const stats = await SmsManager.getStats();
    return c.json({ stats });
  });

  return app;
}
