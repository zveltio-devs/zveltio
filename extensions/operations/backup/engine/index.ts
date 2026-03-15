import type { ZveltioExtension } from '../../../../packages/engine/src/lib/extension-loader.js';
import { backupRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'operations/backup',
  category: 'operations',
  async register(app, ctx) {
    app.route('/api/backup', backupRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
