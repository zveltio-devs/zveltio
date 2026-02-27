import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { roDocumentsRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'compliance/ro/documents',
  category: 'compliance',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_documents.sql')];
  },

  async register(app, ctx) {
    app.route('/api/ro-documents', roDocumentsRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
