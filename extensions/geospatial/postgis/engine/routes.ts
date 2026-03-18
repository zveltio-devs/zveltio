import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';
import { DDLManager } from '../../../../packages/engine/src/lib/ddl-manager.js';

async function getUser(c: any, auth: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Regex for valid PostgreSQL identifier (field/column names)
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/i;

/**
 * Validates that a field name is a safe PostgreSQL identifier.
 * Returns sql.ref(name) if safe, throws otherwise.
 */
function safeRef(name: string): ReturnType<typeof sql.ref> {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Invalid field name: "${name}"`);
  }
  return sql.ref(name);
}

/**
 * Validates a list of field names and returns a safe SQL fragment.
 * Falls back to '*' if fields is empty or undefined.
 */
function safeFieldList(fields: string[] | undefined): ReturnType<typeof sql.raw> | '*' {
  if (!fields || fields.length === 0) return sql.raw('*') as any;
  for (const f of fields) {
    if (!SAFE_IDENTIFIER.test(f)) throw new Error(`Invalid field name: "${f}"`);
  }
  return sql.raw(fields.map(f => `"${f}"`).join(', ')) as any;
}

/**
 * Resolves collection name (with or without zvd_ prefix) to the full table name,
 * and verifies the user has read access. Returns null if not allowed.
 */
async function resolveCollection(
  db: any,
  userId: string,
  collection: string,
): Promise<string | null> {
  // Only user-defined collections allowed
  const shortName = collection.startsWith('zvd_') ? collection.slice(4) : collection;
  if (!/^[a-z][a-z0-9_]*$/.test(shortName)) return null;

  const exists = await DDLManager.tableExists(db, shortName).catch(() => false);
  if (!exists) return null;

  const canRead = await checkPermission(userId, `data:${shortName}`, 'read').catch(() => false);
  if (!canRead) return null;

  return DDLManager.getTableName(shortName);
}

const latLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export function postgisRoutes(db: any, auth: any): Hono {
  const app = new Hono();

  // ─── Proximity search ─────────────────────────────────────────

  // POST /geo/near — find records near a point
  app.post(
    '/near',
    zValidator(
      'json',
      z.object({
        collection: z.string().min(1),
        location_field: z.string().default('location'),
        lat: z.number(),
        lng: z.number(),
        radius_meters: z.number().positive().default(1000),
        limit: z.number().int().positive().max(500).default(20),
        fields: z.array(z.string()).optional(),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const { collection, location_field, lat, lng, radius_meters, limit, fields } = c.req.valid('json');

      const tableName = await resolveCollection(db, user.id, collection);
      if (!tableName) return c.json({ error: 'Collection not found or access denied' }, 403);

      let fieldListSql: any;
      try {
        fieldListSql = safeFieldList(fields);
      } catch (e: any) {
        return c.json({ error: e.message }, 400);
      }

      let locationRef: any;
      try {
        locationRef = safeRef(location_field);
      } catch (e: any) {
        return c.json({ error: e.message }, 400);
      }

      // Coordinates are Zod-validated numbers — safe to interpolate
      const records = await sql`
        SELECT ${fieldListSql},
               ST_Distance(${locationRef}::geography, ST_SetSRID(ST_MakePoint(${sql.lit(lng)}, ${sql.lit(lat)}), 4326)::geography) AS distance_meters
        FROM ${sql.id(tableName)}
        WHERE ST_DWithin(
          ${locationRef}::geography,
          ST_SetSRID(ST_MakePoint(${sql.lit(lng)}, ${sql.lit(lat)}), 4326)::geography,
          ${sql.lit(radius_meters)}
        )
        ORDER BY distance_meters ASC
        LIMIT ${sql.lit(limit)}
      `.execute(db);

      return c.json({ records: records.rows, count: records.rows.length });
    },
  );

  // POST /geo/within-bbox — records within bounding box
  app.post(
    '/within-bbox',
    zValidator(
      'json',
      z.object({
        collection: z.string().min(1),
        location_field: z.string().default('location'),
        min_lat: z.number(),
        min_lng: z.number(),
        max_lat: z.number(),
        max_lng: z.number(),
        limit: z.number().int().positive().max(1000).default(100),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const { collection, location_field, min_lat, min_lng, max_lat, max_lng, limit } = c.req.valid('json');

      const tableName = await resolveCollection(db, user.id, collection);
      if (!tableName) return c.json({ error: 'Collection not found or access denied' }, 403);

      let locationRef: any;
      try {
        locationRef = safeRef(location_field);
      } catch (e: any) {
        return c.json({ error: e.message }, 400);
      }

      const records = await sql`
        SELECT *
        FROM ${sql.id(tableName)}
        WHERE ${locationRef} && ST_SetSRID(ST_MakeEnvelope(${sql.lit(min_lng)}, ${sql.lit(min_lat)}, ${sql.lit(max_lng)}, ${sql.lit(max_lat)}, 4326), 4326)::geography
        LIMIT ${sql.lit(limit)}
      `.execute(db);

      return c.json({ records: records.rows, count: records.rows.length });
    },
  );

  // POST /geo/cluster — cluster points using PostGIS
  app.post(
    '/cluster',
    zValidator(
      'json',
      z.object({
        collection: z.string().min(1),
        location_field: z.string().default('location'),
        eps_meters: z.number().positive().default(500),
        min_points: z.number().int().positive().default(3),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const { collection, location_field, eps_meters, min_points } = c.req.valid('json');

      const tableName = await resolveCollection(db, user.id, collection);
      if (!tableName) return c.json({ error: 'Collection not found or access denied' }, 403);

      let locationRef: any;
      try {
        locationRef = safeRef(location_field);
      } catch (e: any) {
        return c.json({ error: e.message }, 400);
      }

      const result = await sql`
        WITH clustered AS (
          SELECT id,
                 ${locationRef},
                 ST_ClusterDBSCAN(${locationRef}::geometry, ${sql.lit(eps_meters / 111000)}, ${sql.lit(min_points)})
                   OVER () AS cluster_id
          FROM ${sql.id(tableName)}
          WHERE ${locationRef} IS NOT NULL
        )
        SELECT
          cluster_id,
          COUNT(*) AS point_count,
          ST_AsGeoJSON(ST_Centroid(ST_Collect(${locationRef}::geometry)))::jsonb AS centroid
        FROM clustered
        GROUP BY cluster_id
        ORDER BY point_count DESC
      `.execute(db);

      return c.json({ clusters: result.rows });
    },
  );

  // ─── Geofences ─────────────────────────────────────────────────

  app.get('/geofences', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const geofences = await db
      .selectFrom('zv_geofences')
      .select(['id', 'name', 'description', 'metadata', 'is_active', 'created_at'])
      .where('is_active', '=', true)
      .execute();

    return c.json({ geofences });
  });

  app.post(
    '/geofences',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        // Polygon as GeoJSON coordinates array [[[lng, lat], ...]]
        coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
        metadata: z.record(z.any()).default({}),
      }),
    ),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const { name, description, coordinates, metadata } = c.req.valid('json');

      const geojson = JSON.stringify({ type: 'Polygon', coordinates });

      const geofence = await sql`
        INSERT INTO zv_geofences (name, description, zone, metadata)
        VALUES (${name}, ${description || null}, ST_GeographyFromText(ST_AsText(ST_GeomFromGeoJSON(${geojson}))), ${JSON.stringify(metadata)})
        RETURNING id, name, description, is_active, created_at
      `.execute(db);

      return c.json({ geofence: geofence.rows[0] }, 201);
    },
  );

  app.delete('/geofences/:id', async (c) => {
    const user = await getUser(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    await db.updateTable('zv_geofences').set({ is_active: false }).where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  // POST /geofences/:id/contains — check if a point is inside the geofence
  app.post(
    '/geofences/:id/contains',
    zValidator('json', latLng),
    async (c) => {
      const user = await getUser(c, auth);
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      const { lat, lng } = c.req.valid('json');
      const id = c.req.param('id');

      const result = await sql`
        SELECT ST_Contains(zone::geometry, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)) AS contains
        FROM zv_geofences
        WHERE id = ${id}::uuid
      `.execute(db);

      const contains = result.rows[0]?.contains ?? false;
      return c.json({ contains, lat, lng, geofence_id: id });
    },
  );

  return app;
}
