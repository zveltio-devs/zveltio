import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { mailRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'communications/mail',
  category: 'communications',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_mail.sql')];
  },

  async register(app, ctx) {
    app.route('/api/mail', mailRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
