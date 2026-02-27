import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { postgisRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'geospatial/postgis',
  category: 'geospatial',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_postgis.sql')];
  },

  registerFieldTypes(registry) {
    // Polygon field type (stored as WKB geography)
    registry.register({
      type: 'polygon',
      label: 'Polygon (Geography)',
      category: 'location',
      db: {
        columnType: 'GEOGRAPHY(POLYGON, 4326)',
        indexType: 'gist',
        requiresExtensions: ['postgis'],
      },
      api: {
        filterOperators: ['within', 'intersects', 'is_null', 'is_not_null'],
        serialize: (v) => v,
      },
      typescript: {
        inputType: '{ type: "Polygon"; coordinates: number[][][] }',
        outputType: '{ type: "Polygon"; coordinates: number[][][] }',
      },
    });

    // LineString field type
    registry.register({
      type: 'linestring',
      label: 'LineString (Geography)',
      category: 'location',
      db: {
        columnType: 'GEOGRAPHY(LINESTRING, 4326)',
        indexType: 'gist',
        requiresExtensions: ['postgis'],
      },
      api: {
        filterOperators: ['within', 'intersects', 'is_null', 'is_not_null'],
      },
      typescript: {
        inputType: '{ type: "LineString"; coordinates: number[][] }',
        outputType: '{ type: "LineString"; coordinates: number[][] }',
      },
    });
  },

  async register(app, ctx) {
    app.route('/api/geo', postgisRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
