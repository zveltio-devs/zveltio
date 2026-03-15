import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { insightsRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'analytics/insights',
  category: 'analytics',
  async register(app, ctx) {
    app.route('/api/insights', insightsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
