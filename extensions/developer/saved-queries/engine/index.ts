import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { savedQueriesRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'developer/saved-queries',
  category: 'developer',
  async register(app, ctx) {
    app.route('/api/saved-queries', savedQueriesRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
