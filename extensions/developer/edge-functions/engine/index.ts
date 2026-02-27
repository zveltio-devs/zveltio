import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { edgeFunctionsRoutes, mountEdgeFunctions } from './routes.js';

const extension: ZveltioExtension = {
  name: 'developer/edge-functions',
  category: 'developer',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_edge_functions.sql')];
  },

  async register(app, ctx) {
    // Admin routes for managing functions
    app.route('/api/edge-functions', edgeFunctionsRoutes(ctx.db, ctx.auth));

    // Mount all active functions at their configured paths
    await mountEdgeFunctions(app, ctx.db);
  },
};

export default extension;
