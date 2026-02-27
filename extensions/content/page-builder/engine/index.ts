import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { pageBuilderRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'content/page-builder',
  category: 'content',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_pages.sql')];
  },

  async register(app, ctx) {
    app.route('/api/pages', pageBuilderRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
