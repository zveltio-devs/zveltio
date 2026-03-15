import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { tenantsRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'multitenancy',
  category: 'multitenancy',
  async register(app, ctx) {
    app.route('/api/tenants', tenantsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
