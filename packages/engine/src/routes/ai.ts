import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import {
  aiProviderManager,
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  renderTemplate,
  type ChatMessage,
} from '../lib/ai-provider.js';

async function requireAuth(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const user = await requireAuth(c, auth);
  if (!user) return null;
  if (!(await checkPermission(user.id, 'admin', '*'))) return null;
  return user;
}

export function aiRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware (all AI routes require auth)
  app.use('*', async (c, next) => {
    const user = await requireAuth(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // ── Provider status ───────────────────────────────────────────

  // GET /providers — List configured AI providers
  app.get('/providers', (c) => {
    const providers = aiProviderManager.list();
    return c.json({ providers, has_default: !!aiProviderManager.getDefault() });
  });

  // ── Chat completions ──────────────────────────────────────────

  // POST /chat — One-shot chat completion
  app.post(
    '/chat',
    zValidator('json', z.object({
      messages: z.array(z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      })),
      provider: z.string().optional(),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      max_tokens: z.number().int().optional(),
    })),
    async (c) => {
      const { messages, provider: providerName, model, temperature, max_tokens } = c.req.valid('json');

      const provider = providerName
        ? aiProviderManager.get(providerName)
        : aiProviderManager.getDefault();

      if (!provider) {
        return c.json({ error: 'No AI provider configured. Add a provider in Settings > AI.' }, 503);
      }

      const result = await provider.chat(messages as ChatMessage[], { model, temperature, max_tokens });
      return c.json({ result });
    },
  );

  // ── Chat sessions ─────────────────────────────────────────────

  // GET /chats — List user's chat sessions
  app.get('/chats', async (c) => {
    const user = c.get('user') as any;
    const chats = await (db as any)
      .selectFrom('zv_ai_chats')
      .select(['id', 'title', 'provider', 'model', 'created_at', 'updated_at'])
      .where('user_id', '=', user.id)
      .orderBy('updated_at', 'desc')
      .limit(50)
      .execute();
    return c.json({ chats });
  });

  // POST /chats — Create new chat session
  app.post(
    '/chats',
    zValidator('json', z.object({
      title: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      context: z.string().optional(), // system message
    })),
    async (c) => {
      const user = c.get('user') as any;
      const { title, provider, model, context } = c.req.valid('json');

      const chat = await (db as any)
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

  // GET /chats/:id — Get chat with messages
  app.get('/chats/:id', async (c) => {
    const user = c.get('user') as any;
    const chat = await (db as any)
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

  // POST /chats/:id/messages — Send a message in a chat session
  app.post(
    '/chats/:id/messages',
    zValidator('json', z.object({ content: z.string().min(1) })),
    async (c) => {
      const user = c.get('user') as any;
      const { content } = c.req.valid('json');

      const chat = await (db as any)
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

      // Build messages array (with optional system context)
      const messages: ChatMessage[] = [];
      if (chat.context) messages.push({ role: 'system', content: chat.context });
      messages.push(...existingMessages);
      messages.push({ role: 'user', content });

      const result = await provider.chat(messages, { model: chat.model || undefined });

      // Append both user and assistant messages
      const updatedMessages = [
        ...existingMessages,
        { role: 'user' as const, content },
        { role: 'assistant' as const, content: result.content },
      ];

      // Update chat (auto-generate title from first message if missing)
      const title = chat.title === 'New Chat' && existingMessages.length === 0
        ? content.slice(0, 60)
        : chat.title;

      await (db as any)
        .updateTable('zv_ai_chats')
        .set({
          messages: JSON.stringify(updatedMessages),
          title,
          updated_at: new Date(),
        })
        .where('id', '=', chat.id)
        .execute();

      return c.json({ message: { role: 'assistant', content: result.content }, usage: result.usage });
    },
  );

  // DELETE /chats/:id — Delete chat session
  app.delete('/chats/:id', async (c) => {
    const user = c.get('user') as any;
    await (db as any)
      .deleteFrom('zv_ai_chats')
      .where('id', '=', c.req.param('id'))
      .where('user_id', '=', user.id)
      .execute();
    return c.json({ success: true });
  });

  // ── Prompt Templates ──────────────────────────────────────────

  // GET /templates — List prompt templates
  app.get('/templates', async (c) => {
    const { category } = c.req.query();
    let query = (db as any)
      .selectFrom('zv_prompt_templates')
      .selectAll()
      .where('is_active', '=', true)
      .orderBy('name', 'asc');

    if (category) query = query.where('category', '=', category);

    const templates = await query.execute();
    return c.json({ templates });
  });

  // POST /templates/:id/run — Execute a prompt template
  app.post(
    '/templates/:id/run',
    zValidator('json', z.object({
      variables: z.record(z.string()).default({}),
      provider: z.string().optional(),
    })),
    async (c) => {
      const { variables, provider: providerName } = c.req.valid('json');

      const template = await (db as any)
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
        const userContent = renderTemplate(template.user_template, variables);
        messages.push({ role: 'user', content: userContent });
      }

      const result = await provider.chat(messages, {
        model: template.model || undefined,
        temperature: template.temperature ? Number(template.temperature) : undefined,
        max_tokens: template.max_tokens || undefined,
      });

      return c.json({ result, template_name: template.name });
    },
  );

  // ── Embeddings ────────────────────────────────────────────────

  // POST /embed — Generate embeddings
  app.post(
    '/embed',
    zValidator('json', z.object({
      text: z.union([z.string(), z.array(z.string())]),
      provider: z.string().optional(),
      model: z.string().optional(),
    })),
    async (c) => {
      const { text, provider: providerName, model } = c.req.valid('json');

      const provider = providerName
        ? aiProviderManager.get(providerName)
        : aiProviderManager.getDefault();

      if (!provider) return c.json({ error: 'No AI provider configured' }, 503);
      if (!provider.embed) return c.json({ error: `Provider '${provider.name}' does not support embeddings` }, 400);

      const texts = Array.isArray(text) ? text : [text];
      const results = await Promise.all(texts.map((t) => provider.embed!(t, model)));

      return c.json({ embeddings: results });
    },
  );

  // ── Admin: Provider management ────────────────────────────────

  // POST /admin/providers — Add/update AI provider config (admin)
  app.post(
    '/admin/providers',
    zValidator('json', z.object({
      name: z.string().min(1),
      label: z.string().min(1),
      api_key: z.string().optional(),
      base_url: z.string().url().optional(),
      default_model: z.string().optional(),
      is_default: z.boolean().default(false),
    })),
    async (c) => {
      const user = c.get('user') as any;
      if (!(await checkPermission(user.id, 'admin', '*'))) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      const data = c.req.valid('json');

      if (data.is_default) {
        await (db as any)
          .updateTable('zv_ai_providers')
          .set({ is_default: false })
          .where('is_default', '=', true)
          .execute();
      }

      const provider = await sql`
        INSERT INTO zv_ai_providers (name, label, api_key, base_url, default_model, is_default)
        VALUES (${data.name}, ${data.label}, ${data.api_key ?? null}, ${data.base_url ?? null}, ${data.default_model ?? null}, ${data.is_default})
        ON CONFLICT (name) DO UPDATE SET
          label = EXCLUDED.label,
          api_key = COALESCE(EXCLUDED.api_key, zv_ai_providers.api_key),
          base_url = EXCLUDED.base_url,
          default_model = EXCLUDED.default_model,
          is_default = EXCLUDED.is_default,
          updated_at = NOW()
        RETURNING *
      `.execute(db);

      // Re-register in memory
      const row = provider.rows[0] as any;
      let p;
      if (row.name === 'openai' && row.api_key) {
        p = new OpenAIProvider(row.api_key, row.base_url || undefined, row.default_model || undefined);
      } else if (row.name === 'anthropic' && row.api_key) {
        p = new AnthropicProvider(row.api_key, row.default_model || undefined);
      } else if (row.name === 'ollama') {
        p = new OllamaProvider(row.base_url || undefined, row.default_model || undefined);
      }
      if (p) aiProviderManager.register(p, row.is_default);

      return c.json({ provider: row }, 201);
    },
  );

  // DELETE /admin/providers/:name — Remove provider (admin)
  app.delete('/admin/providers/:name', async (c) => {
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await (db as any)
      .deleteFrom('zv_ai_providers')
      .where('name', '=', c.req.param('name'))
      .execute();

    return c.json({ success: true });
  });

  // ── Admin: Prompt Templates CRUD ─────────────────────────────

  // POST /admin/templates — Create template (admin)
  app.post(
    '/admin/templates',
    zValidator('json', z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      system_prompt: z.string().min(1),
      user_template: z.string().optional(),
      variables: z.array(z.object({ name: z.string(), description: z.string().optional(), required: z.boolean().default(false) })).default([]),
      category: z.string().default('general'),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).default(0.7),
      max_tokens: z.number().int().default(2048),
    })),
    async (c) => {
      const user = c.get('user') as any;
      if (!(await checkPermission(user.id, 'admin', '*'))) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      const data = c.req.valid('json');
      const template = await (db as any)
        .insertInto('zv_prompt_templates')
        .values({ ...data, variables: JSON.stringify(data.variables), created_by: user.id })
        .returningAll()
        .executeTakeFirst();

      return c.json({ template }, 201);
    },
  );

  // DELETE /admin/templates/:id — Delete template (admin)
  app.delete('/admin/templates/:id', async (c) => {
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await (db as any)
      .deleteFrom('zv_prompt_templates')
      .where('id', '=', c.req.param('id'))
      .execute();

    return c.json({ success: true });
  });

  return app;
}
