import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { apiDocsRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'developer/api-docs',
  category: 'developer',
  async register(app, ctx) {
    app.route('/api/docs', apiDocsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
