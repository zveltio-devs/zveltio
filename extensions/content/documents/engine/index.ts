import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { documentsRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'content/documents',
  category: 'content',
  async register(app, ctx) {
    app.route('/api/documents', documentsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
