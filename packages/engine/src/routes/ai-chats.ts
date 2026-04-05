import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { aiProviderManager, type ChatMessage } from '../lib/ai-provider.js';
import { checkPermission } from '../lib/permissions.js';

async function requireAuth(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const user = await requireAuth(c, auth);
  if (!user) return null;
  const isAdmin = await checkPermission(user.id, 'admin', '*');
  return isAdmin ? user : null;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Renders {{key}} placeholders with HTML-escaped values so that user-supplied
// variables cannot inject markup/script into AI prompt templates.
function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(variables[key] ?? ''));
}

export function aiChatsRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await requireAuth(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // ── Chat Sessions (zv_ai_chats) ───────────────────────────────

  app.get('/chats', async (c) => {
    const user = c.get('user') as any;
    const chats = await db
      .selectFrom('zv_ai_chats')
      .select(['id', 'title', 'provider', 'model', 'created_at', 'updated_at'])
      .where('user_id', '=', user.id)
      .orderBy('updated_at', 'desc')
      .limit(50)
      .execute();
    return c.json({ chats });
  });

  app.post(
    '/chats',
    zValidator('json', z.object({
      title: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      context: z.string().optional(),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const { title, provider, model, context } = c.req.valid('json');
      const chat = await db
        .insertInto('zv_ai_chats')
        .values({
          user_id: user.id,
          title: title || 'New Chat',
          provider: provider || 'default',
          model: model || null,
          context: context || null,
          messages: JSON.stringify([]),
        })
        .returningAll()
        .executeTakeFirst();
      return c.json({ chat }, 201);
    },
  );

  app.get('/chats/:id', async (c) => {
    const user = c.get('user') as any;
    const chat = await db
      .selectFrom('zv_ai_chats')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (!chat) return c.json({ error: 'Chat not found' }, 404);
    return c.json({
      chat: {
        ...chat,
        messages: typeof chat.messages === 'string' ? JSON.parse(chat.messages) : chat.messages,
      },
    });
  });

  app.post(
    '/chats/:id/messages',
    zValidator('json', z.object({ content: z.string().min(1) })),
    async (c) => {
      const user = c.get('user') as any;
      const { content } = c.req.valid('json');
      const chat = await db
        .selectFrom('zv_ai_chats')
        .selectAll()
        .where('id', '=', c.req.param('id'))
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      if (!chat) return c.json({ error: 'Chat not found' }, 404);

      const providerName = chat.provider === 'default' ? undefined : chat.provider;
      const provider = providerName
        ? aiProviderManager.get(providerName)
        : aiProviderManager.getDefault();
      if (!provider) return c.json({ error: 'No AI provider configured' }, 503);

      const existingMessages: ChatMessage[] = typeof chat.messages === 'string'
        ? JSON.parse(chat.messages)
        : chat.messages;

      const messages: ChatMessage[] = [];
      if (chat.context) messages.push({ role: 'system', content: chat.context });
      messages.push(...existingMessages);
      messages.push({ role: 'user', content });

      const result = await provider.chat(messages, { model: chat.model || undefined });

      const updatedMessages = [
        ...existingMessages,
        { role: 'user' as const, content },
        { role: 'assistant' as const, content: result.content },
      ];

      const title = chat.title === 'New Chat' && existingMessages.length === 0
        ? content.slice(0, 60)
        : chat.title;

      await db
        .updateTable('zv_ai_chats')
        .set({ messages: JSON.stringify(updatedMessages), title, updated_at: new Date() })
        .where('id', '=', chat.id)
        .execute();

      return c.json({ message: { role: 'assistant', content: result.content }, usage: result.usage });
    },
  );

  app.delete('/chats/:id', async (c) => {
    const user = c.get('user') as any;
    await db
      .deleteFrom('zv_ai_chats')
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // ── Prompt Templates (zv_prompt_templates) ────────────────────

  app.get('/templates', async (c) => {
    const { category } = c.req.query();
    let query = db
      .selectFrom('zv_prompt_templates')
      .selectAll()
      .where('is_active', '=', true)
      .orderBy('name', 'asc');
    if (category) query = query.where('category', '=', category);
    const templates = await query.execute();
    return c.json({ templates });
  });

  app.post(
    '/templates/:id/run',
    zValidator('json', z.object({
      variables: z.record(z.string(), z.string()).default({}),
      provider: z.string().optional(),
    })),
    async (c) => {
      const { variables, provider: providerName } = c.req.valid('json');
      const template = await db
        .selectFrom('zv_prompt_templates')
        .selectAll()
        .where('id', '=', c.req.param('id'))
        .where('is_active', '=', true)
        .executeTakeFirst();
      if (!template) return c.json({ error: 'Template not found' }, 404);

      const provider = providerName
        ? aiProviderManager.get(providerName)
        : (template.provider ? aiProviderManager.get(template.provider) : aiProviderManager.getDefault());
      if (!provider) return c.json({ error: 'No AI provider configured' }, 503);

      const messages: ChatMessage[] = [{ role: 'system', content: template.system_prompt }];
      if (template.user_template) {
        messages.push({ role: 'user', content: renderTemplate(template.user_template, variables) });
      }

      const result = await provider.chat(messages, {
        model: template.model || undefined,
        temperature: template.temperature ? Number(template.temperature) : undefined,
        max_tokens: template.max_tokens || undefined,
      });

      return c.json({ result, template_name: template.name });
    },
  );

  app.post(
    '/admin/templates',
    zValidator('json', z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      system_prompt: z.string().min(1),
      user_template: z.string().optional(),
      variables: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        required: z.boolean().default(false),
      })).default([]),
      category: z.string().default('general'),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).default(0.7),
      max_tokens: z.number().int().default(2048),
    })),
    async (c) => {
      const user = c.get('user') as any;
      const admin = await requireAdmin(c, auth);
      if (!admin) return c.json({ error: 'Admin access required' }, 403);
      const data = c.req.valid('json');
      const template = await db
        .insertInto('zv_prompt_templates')
        .values({ ...data, variables: JSON.stringify(data.variables), created_by: user.id })
        .returningAll()
        .executeTakeFirst();
      return c.json({ template }, 201);
    },
  );

  app.delete('/admin/templates/:id', async (c) => {
    const admin = await requireAdmin(c, auth);
    if (!admin) return c.json({ error: 'Admin access required' }, 403);
    await db
      .deleteFrom('zv_prompt_templates')
      .where('id', '=', c.req.param('id'))
      .execute();
    return c.json({ success: true });
  });

  return app;
}
