import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { etransportRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'compliance/ro/etransport',
  category: 'compliance',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_etransport.sql')];
  },

  async register(app, ctx) {
    app.route('/api/etransport', etransportRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
