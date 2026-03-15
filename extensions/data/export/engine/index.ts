import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { exportRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'data/export',
  category: 'data',
  async register(app, ctx) {
    app.route('/api/export', exportRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
