import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { validationRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'developer/validation',
  category: 'developer',
  async register(app, ctx) {
    app.route('/api/validation', validationRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
