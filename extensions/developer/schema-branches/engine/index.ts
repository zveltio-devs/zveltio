import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { schemaBranchesRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'developer/schema-branches',
  category: 'developer',
  async register(app, ctx) {
    app.route('/api/schema', schemaBranchesRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
