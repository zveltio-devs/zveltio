import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { documentTemplatesRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'content/document-templates',
  category: 'content',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_document_templates.sql')];
  },

  async register(app, ctx) {
    app.route('/api/document-templates', documentTemplatesRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
