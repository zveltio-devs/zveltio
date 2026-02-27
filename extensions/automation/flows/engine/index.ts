import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { flowsRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'automation/flows',
  category: 'automation',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_flows.sql')];
  },

  async register(app, ctx) {
    app.route('/api/flows', flowsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
