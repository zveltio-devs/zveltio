import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { databaseRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'developer/database',
  category: 'developer',
  async register(app, ctx) {
    app.route('/api/database', databaseRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
