import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { ldapRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'auth/ldap',
  category: 'auth',
  async register(app, ctx) {
    app.route('/api/auth/ldap', ldapRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
