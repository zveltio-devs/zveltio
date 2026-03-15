import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { samlRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'auth/saml',
  category: 'auth',
  async register(app, ctx) {
    app.route('/api/auth/saml', samlRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
