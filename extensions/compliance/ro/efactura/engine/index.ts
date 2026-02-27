import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { efacturaRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'compliance/ro/efactura',
  category: 'compliance',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_efactura.sql')];
  },

  async register(app, ctx) {
    app.route('/api/efactura', efacturaRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
