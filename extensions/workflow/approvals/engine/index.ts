import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { approvalsRoutes } from './routes.js';
import { join } from 'path';

const extension: ZveltioExtension = {
  name: 'workflow/approvals',
  category: 'workflow',

  getMigrations() {
    return [
      join(import.meta.dir, 'migrations/001_approvals.sql'),
    ];
  },

  async register(app, ctx) {
    app.route('/api/approvals', approvalsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
