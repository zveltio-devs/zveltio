import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { aiRoutes } from './routes.js';
import { initAIProviders, aiProviderManager } from './ai-provider.js';

const extension: ZveltioExtension = {
  name: 'ai/core-ai',
  category: 'ai',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_ai.sql')];
  },

  async register(app, ctx) {
    // Initialize providers from DB configuration
    await initAIProviders(ctx.db);

    // Register API routes
    app.route('/api/ai', aiRoutes(ctx.db, ctx.auth));

    // Expose provider manager via context for other extensions
    (ctx as any).aiProviderManager = aiProviderManager;
  },
};

export default extension;
