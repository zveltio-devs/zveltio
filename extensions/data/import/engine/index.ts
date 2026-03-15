import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { importRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'data/import',
  category: 'data',
  async register(app, ctx) {
    app.route('/api/import', importRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
