import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { mediaRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'content/media',
  category: 'content',
  async register(app, ctx) {
    app.route('/api/media', mediaRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
