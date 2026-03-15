import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { gdprRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'compliance/gdpr',
  category: 'compliance',
  async register(app, ctx) {
    app.route('/api/gdpr', gdprRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
