import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { saftRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'compliance/ro/saft',
  category: 'compliance',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_saft.sql')];
  },

  async register(app, ctx) {
    app.route('/api/saft', saftRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
