import type { ZveltioExtension } from '../../../packages/engine/src/lib/extension-loader.js';
import { crmRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'crm',
  category: 'business',

  async register(app, ctx) {
    const routes = crmRoutes(ctx.db, ctx.auth);
    app.route('/api', routes);
  },
};

export default extension;
