import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { aiRoutes } from './routes.js';
import { aiChatsRoutes } from './routes-chats.js';
import { zveltioAIRoutes } from './zveltio-ai-routes.js';
import { aiAnalyticsRoutes } from './analytics.js';
import { initAIProviders, aiProviderManager } from './ai-provider.js';
import { aiAlchemistRoutes } from './ai-alchemist.js';
import { aiQueryRoutes } from './ai-query.js';
import { aiSchemaGenRoutes } from './ai-schema-gen.js';

const extension: ZveltioExtension = {
  name: 'ai/core-ai',
  category: 'ai',

  getMigrations() {
    return [
      join(import.meta.dir, 'migrations/001_ai.sql'),
      join(import.meta.dir, 'migrations/002_zveltio_ai.sql'),
      join(import.meta.dir, 'migrations/003_ai_memory.sql'),
    ];
  },

  async register(app, ctx) {
    // Initialize providers from DB configuration
    await initAIProviders(ctx.db);

    // Core AI routes: providers, chat, embed, search, prompts, usage, admin/features
    app.route('/api/ai', aiRoutes(ctx.db, ctx.auth));

    // Chat sessions + prompt templates (zv_ai_chats, zv_prompt_templates)
    app.route('/api/ai', aiChatsRoutes(ctx.db, ctx.auth));

    // Zveltio AI Agent: conversational NL interface to data
    app.route('/api/zveltio-ai', zveltioAIRoutes(ctx.db, ctx.auth));

    // AI analytics: usage/cost tracking dashboard
    app.route('/api/ai-analytics', aiAnalyticsRoutes(ctx.db, ctx.auth));

    // Data Alchemist: documents → structured database
    app.route('/api/ai/alchemist', aiAlchemistRoutes(ctx.db, ctx.auth));

    // Text-to-SQL AI copilot
    app.route('/api/ai/query', aiQueryRoutes(ctx.db, ctx.auth));

    // Prompt-to-schema generator
    app.route('/api/ai', aiSchemaGenRoutes(ctx.db, ctx.auth));

    // Expose provider manager via context for other extensions
    (ctx as any).aiProviderManager = aiProviderManager;
  },
};

export default extension;
