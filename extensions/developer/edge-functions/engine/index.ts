import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { edgeFunctionsRoutes, mountEdgeFunctions } from './routes.js';

const extension: ZveltioExtension = {
  name: 'developer/edge-functions',
  category: 'developer',

  async register(app, ctx) {
    // Admin CRUD routes (/api/edge-functions)
    app.route('/api/edge-functions', edgeFunctionsRoutes(ctx.db, ctx.auth));

    // Mount active functions at their configured paths (e.g. /api/fn/my-function)
    await mountEdgeFunctions(app, ctx.db);
  },
};

export default extension;
