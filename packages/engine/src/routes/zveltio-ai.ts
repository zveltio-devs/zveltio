/**
 * Zveltio AI Agent Routes
 *
 * POST   /api/zveltio-ai/chat                  — send a natural-language request
 * GET    /api/zveltio-ai/conversations/:id      — get conversation history
 * DELETE /api/zveltio-ai/conversations/:id      — clear a conversation
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ZveltioAIEngine } from '../lib/zveltio-ai/engine.js';

export function zveltioAIRoutes(db: any, auth: any): Hono {
  const app = new Hono();
  const engine = new ZveltioAIEngine(db);

  async function getUser(c: any) {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return session?.user ?? null;
  }

  // POST /chat — process natural-language request
  app.post(
    '/chat',
    zValidator(
      'json',
      z.object({
        message: z.string().min(1).max(8000),
        conversation_id: z.string().optional(),
        context: z.record(z.string(), z.any()).optional(),
      }),
    ),
    async (c) => {
      const user = await getUser(c);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const body = c.req.valid('json');

      const response = await engine.processRequest({
        message: body.message,
        userId: user.id,
        conversationId: body.conversation_id,
        context: body.context,
      });

      return c.json(response);
    },
  );

  // GET /conversations/:id — get conversation history
  app.get('/conversations/:id', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const conversationId = c.req.param('id');
    const limit = parseInt(c.req.query('limit') || '50');

    const messages = await db
      .selectFrom('zv_ai_chat_history')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'asc')
      .limit(Math.min(limit, 200))
      .execute()
      .catch(() => []);

    return c.json({ conversation_id: conversationId, messages });
  });

  // GET /conversations — list user's conversations
  app.get('/conversations', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const conversations = await db
      .selectFrom('zv_ai_chat_history')
      .select(['conversation_id'])
      .select(db.fn.max('created_at').as('last_message_at'))
      .select(db.fn.count('id').as('message_count'))
      .where('user_id', '=', user.id)
      .groupBy('conversation_id')
      .orderBy('last_message_at', 'desc')
      .limit(20)
      .execute()
      .catch(() => []);

    return c.json({ conversations });
  });

  // DELETE /conversations/:id — clear conversation history
  app.delete('/conversations/:id', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const conversationId = c.req.param('id');

    await db
      .deleteFrom('zv_ai_chat_history')
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', user.id)
      .execute()
      .catch(() => {});

    return c.json({ success: true });
  });

  return app;
}
