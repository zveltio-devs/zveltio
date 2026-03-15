import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { translationsRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'i18n/translations',
  category: 'i18n',
  async register(app, ctx) {
    app.route('/api/translations', translationsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
