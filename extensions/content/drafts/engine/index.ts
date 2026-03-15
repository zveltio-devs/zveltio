import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { draftsRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'content/drafts',
  category: 'content',
  async register(app, ctx) {
    app.route('/api/drafts', draftsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
