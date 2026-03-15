import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { qualityRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'analytics/quality',
  category: 'analytics',
  async register(app, ctx) {
    app.route('/api/quality', qualityRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
