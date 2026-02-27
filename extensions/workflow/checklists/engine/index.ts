import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { checklistsRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'workflow/checklists',
  category: 'workflow',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_checklists.sql')];
  },

  async register(app, ctx) {
    app.route('/api/checklists', checklistsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
