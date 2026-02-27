import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { aiProviderManager, OpenAIProvider, AnthropicProvider, OllamaProvider } from './ai-provider.js';

async function requireAuth(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

export function aiRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  // ─── Providers ────────────────────────────────────────────────

  // GET /providers — list configured providers
  app.get('/providers', async (c) => {
    const user = await requireAuth(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const providers = await db
      .selectFrom('zv_ai_providers')
      .select(['id', 'name', 'display_name', 'default_model', 'base_url', 'is_default', 'is_active'])
      .orderBy('name', 'asc')
      .execute();

    const activeNames = aiProviderManager.list();

    return c.json({
      providers: providers.map((p: any) => ({
        ...p,
        loaded: activeNames.includes(p.name),
      })),
    });
  });

  // PUT /providers/:name — configure a provider
  app.put(
    '/providers/:name',
    zValidator(
      'json',
      z.object({
        display_name: z.string().optional(),
        api_key: z.string().optional(),
        base_url: z.string().url().optional(),
        default_model: z.string().optional(),
        is_default: z.boolean().optional(),
        is_active: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const user = await requireAuth(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const name = c.req.param('name');
      const body = c.req.valid('json');
      const now = new Date();

      const existing = await db
        .selectFrom('zv_ai_providers')
        .selectAll()
        .where('name', '=', name)
        .executeTakeFirst();

      if (existing) {
        await db.updateTable('zv_ai_providers')
          .set({ ...body, updated_at: now })
          .where('name', '=', name)
          .execute();
      } else {
        const displayNames: Record<string, string> = {
          openai: 'OpenAI',
          anthropic: 'Anthropic (Claude)',
          gemini: 'Google Gemini',
          ollama: 'Ollama (Local)',
        };
        await db.insertInto('zv_ai_providers')
          .values({
            name,
            display_name: body.display_name || displayNames[name] || name,
            api_key: body.api_key,
            base_url: body.base_url,
            default_model: body.default_model,
            is_default: body.is_default ?? false,
            is_active: body.is_active ?? true,
          })
          .execute();
      }

      // If marking as default, clear others
      if (body.is_default) {
        await db.updateTable('zv_ai_providers')
          .set({ is_default: false })
          .where('name', '!=', name)
          .execute();
      }

      // Hot-reload provider
      const updated = await db
        .selectFrom('zv_ai_providers')
        .selectAll()
        .where('name', '=', name)
        .executeTakeFirst();

      if (updated?.is_active && updated.api_key) {
        let provider = null;
        if (name === 'openai') provider = new OpenAIProvider(updated.api_key, updated.base_url, updated.default_model);
        else if (name === 'anthropic') provider = new AnthropicProvider(updated.api_key, updated.default_model);
        else if (name === 'ollama') provider = new OllamaProvider(updated.base_url, updated.default_model);
        if (provider) aiProviderManager.register(provider, updated.is_default);
      }

      return c.json({ success: true });
    },
  );

  // ─── Chat ─────────────────────────────────────────────────────

  app.post(
    '/chat',
    zValidator(
      'json',
      z.object({
        messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })),
        provider: z.string().optional(),
        model: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().positive().optional(),
      }),
    ),
    async (c) => {
      const user = await requireAuth(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const { messages, provider: providerName, ...opts } = c.req.valid('json');

      const provider = providerName
        ? aiProviderManager.get(providerName)
        : aiProviderManager.getDefault();

      if (!provider) {
        return c.json({ error: 'No AI provider configured. Add a provider in AI Settings.' }, 503);
      }

      const start = Date.now();
      const result = await provider.chat(messages, opts);
      const latency = Date.now() - start;

      // Log usage
      await db.insertInto('zv_ai_usage').values({
        provider: provider.name,
        model: result.model,
        operation: 'chat',
        prompt_tokens: result.usage.prompt_tokens,
        response_tokens: result.usage.response_tokens,
        latency_ms: latency,
        user_id: user.id,
      }).execute().catch(() => {});

      return c.json({ result });
    },
  );

  // ─── Prompt templates ──────────────────────────────────────────

  app.get('/prompts', async (c) => {
    const user = await requireAuth(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const prompts = await db
      .selectFrom('zv_ai_prompts')
      .selectAll()
      .where('is_active', '=', true)
      .orderBy('name', 'asc')
      .execute();

    return c.json({ prompts });
  });

  app.post(
    '/prompts',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        system: z.string().optional(),
        template: z.string().min(1),
        variables: z.array(z.object({
          name: z.string(),
          description: z.string().optional(),
          required: z.boolean().default(false),
        })).default([]),
        category: z.string().optional(),
      }),
    ),
    async (c) => {
      const user = await requireAuth(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const body = c.req.valid('json');
      const prompt = await db.insertInto('zv_ai_prompts')
        .values({ ...body, variables: JSON.stringify(body.variables) })
        .returningAll()
        .executeTakeFirst();

      return c.json({ prompt }, 201);
    },
  );

  app.delete('/prompts/:id', async (c) => {
    const user = await requireAuth(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db.updateTable('zv_ai_prompts')
      .set({ is_active: false })
      .where('id', '=', c.req.param('id'))
      .execute();

    return c.json({ success: true });
  });

  // POST /prompts/:id/run — render template and run
  app.post(
    '/prompts/:id/run',
    zValidator('json', z.record(z.string())),
    async (c) => {
      const user = await requireAuth(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const prompt = await db
        .selectFrom('zv_ai_prompts')
        .selectAll()
        .where('id', '=', c.req.param('id'))
        .where('is_active', '=', true)
        .executeTakeFirst();

      if (!prompt) return c.json({ error: 'Prompt not found' }, 404);

      const vars = c.req.valid('json');
      let rendered = prompt.template;
      for (const [k, v] of Object.entries(vars)) {
        rendered = rendered.replaceAll(`{{${k}}}`, String(v));
      }

      const messages: any[] = [];
      if (prompt.system) messages.push({ role: 'system', content: prompt.system });
      messages.push({ role: 'user', content: rendered });

      const provider = aiProviderManager.getDefault();
      if (!provider) return c.json({ error: 'No AI provider configured' }, 503);

      const result = await provider.chat(messages);
      return c.json({ result, rendered_prompt: rendered });
    },
  );

  // ─── Usage stats ───────────────────────────────────────────────

  app.get('/usage', async (c) => {
    const user = await requireAuth(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { days = '30' } = c.req.query();
    const since = new Date(Date.now() - parseInt(days) * 86400_000);

    const usage = await db
      .selectFrom('zv_ai_usage')
      .select([
        'provider',
        'model',
        db.fn.count('id').as('requests'),
        db.fn.sum('prompt_tokens').as('prompt_tokens'),
        db.fn.sum('response_tokens').as('response_tokens'),
        db.fn.avg('latency_ms').as('avg_latency_ms'),
      ])
      .where('created_at', '>=', since)
      .groupBy(['provider', 'model'])
      .orderBy('requests', 'desc')
      .execute();

    return c.json({ usage, period_days: parseInt(days) });
  });

  return app;
}
