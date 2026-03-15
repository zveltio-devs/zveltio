import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { graphqlRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'developer/graphql',
  category: 'developer',
  async register(app, ctx) {
    app.route('/api/graphql', graphqlRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
