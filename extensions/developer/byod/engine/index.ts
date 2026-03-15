import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { introspectRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'developer/byod',
  category: 'developer',
  async register(app, ctx) {
    app.route('/api/introspect', introspectRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
