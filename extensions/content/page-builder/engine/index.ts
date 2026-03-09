import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { pageBuilderRoutes } from './routes.js';
import { publicPagesRoutes, adminPagesRoutes } from './cms-routes.js';

const extension: ZveltioExtension = {
  name: 'content/page-builder',
  category: 'content',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_pages.sql')];
  },

  async register(app, ctx) {
    // Visual block editor routes
    app.route('/api/pages', pageBuilderRoutes(ctx.db, ctx.auth));
    // CMS page management (public read + admin CRUD)
    app.route('/api/cms/pages', publicPagesRoutes(ctx.db));
    app.route('/api/admin/cms/pages', adminPagesRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
