import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { cloudRoutes, publicShareRouter, createCloudS3Client } from './routes.js';

const extension: ZveltioExtension = {
  name: 'storage/cloud',
  category: 'storage',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_cloud.sql')];
  },

  async register(app, ctx) {
    const s3 = createCloudS3Client();
    app.route('/api/cloud', cloudRoutes(ctx.db, ctx.auth, s3));
    app.route('/share', publicShareRouter(ctx.db, s3));
  },
};

export default extension;
