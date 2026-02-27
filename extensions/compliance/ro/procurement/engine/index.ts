import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { roProcurementRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'compliance/ro/procurement',
  category: 'compliance',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_procurement.sql')];
  },

  async register(app, ctx) {
    app.route('/api/ro-procurement', roProcurementRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
