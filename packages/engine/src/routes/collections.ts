import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Database } from '../db/index.js';
import { DDLManager, CollectionSchema, FieldSchema } from '../lib/ddl-manager.js';
import { checkPermission } from '../lib/permissions.js';
import { enqueueDDLJob, getDDLJob } from '../lib/ddl-queue.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { dynamicAddColumn, dynamicDropColumn } from '../db/dynamic.js';
import { SYSTEM_COLLECTIONS } from '../lib/system-collections.js';
import { z } from 'zod';

// Auth helper — checks session from request headers
async function requireAdmin(c: any, auth: any): Promise<any> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const hasAdmin = await checkPermission(session.user.id, 'admin', '*');
  if (!hasAdmin) return null;
  return session.user;
}

export function collectionsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Admin auth middleware
  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET / — List all collections (user-defined + system)
  app.get('/', async (c) => {
    const collections = await DDLManager.getCollections(db);
    // Append system collections (Better-Auth tables) so Studio can browse them
    const systemCollections = SYSTEM_COLLECTIONS.map((sc) => ({
      name: sc.name,
      display_name: sc.displayName,
      icon: sc.icon,
      is_system: true,
      readonly: sc.readonly,
      fields: sc.fields,
    }));
    return c.json({ collections: [...collections, ...systemCollections] });
  });

  // GET /field-types — Available field types (from registry, including extension types)
  app.get('/field-types', (c) => {
    const types = fieldTypeRegistry.getAll().map((t) => ({
      type: t.type,
      label: t.label,
      description: t.description,
      icon: t.icon,
      category: t.category,
      filterOperators: t.api.filterOperators || [],
      typescript: t.typescript,
    }));
    return c.json({ field_types: types });
  });

  // POST / — Create collection (async via DDL queue)
  app.post(
    '/',
    zValidator('json', CollectionSchema),
    async (c) => {
      const data = c.req.valid('json');

      // Validate field types against registry
      for (const field of data.fields) {
        if (!fieldTypeRegistry.has(field.type)) {
          return c.json(
            { error: `Unknown field type: "${field.type}". Use GET /api/collections/field-types for available types.` },
            400,
          );
        }
      }

      try {
        const jobId = await enqueueDDLJob(db, 'create_collection', data);
        return c.json(
          {
            success: true,
            message: `Collection '${data.name}' is being created`,
            job_id: jobId,
            collection: data,
          },
          202,
        );
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 400);
      }
    },
  );

  // GET /jobs/:jobId — Check DDL job status
  app.get('/jobs/:jobId', async (c) => {
    const job = await getDDLJob(db, c.req.param('jobId'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json({ job });
  });

  // GET /:name — Get collection details
  app.get('/:name', async (c) => {
    const collection = await DDLManager.getCollection(db, c.req.param('name'));
    if (!collection) return c.json({ error: 'Collection not found' }, 404);
    return c.json({ collection });
  });

  // PATCH /:name — Update collection metadata
  app.patch(
    '/:name',
    zValidator(
      'json',
      z.object({
        displayName: z.string().optional(),
        icon: z.string().optional(),
        description: z.string().optional(),
        aiSearchEnabled: z.boolean().optional(),
        aiSearchField: z.string().nullable().optional(),
      }),
    ),
    async (c) => {
      const name = c.req.param('name');
      const updates = c.req.valid('json');
      await DDLManager.updateCollectionMetadata(db, name, updates);
      return c.json({ success: true });
    },
  );

  // DELETE /:name — Delete collection
  app.delete('/:name', async (c) => {
    const name = c.req.param('name');
    try {
      await DDLManager.dropCollection(db, name);
      return c.json({ success: true, message: `Collection '${name}' deleted` });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 400);
    }
  });

  // POST /:name/fields — Add a field to existing collection
  app.post(
    '/:name/fields',
    zValidator('json', FieldSchema),
    async (c) => {
      const name = c.req.param('name');
      const field = c.req.valid('json');

      const collection = await DDLManager.getCollection(db, name);
      if (!collection) return c.json({ error: 'Collection not found' }, 404);

      if (!fieldTypeRegistry.has(field.type)) {
        return c.json({ error: `Unknown field type: "${field.type}"` }, 400);
      }

      const existingFields: any[] = typeof collection.fields === 'string'
        ? JSON.parse(collection.fields)
        : (collection.fields ?? []);
      if (existingFields.some((f: any) => f.name === field.name)) {
        return c.json({ error: `Field "${field.name}" already exists in collection "${name}"` }, 409);
      }

      const tableName = DDLManager.getTableName(name);
      const colDDL = fieldTypeRegistry.getColumnDDL(field as any);

      if (colDDL) {
        await db.schema
          .alterTable(tableName)
          .addColumn(field.name as any, field.type as any)
          .execute()
          .catch(async () => {
            // Fallback for complex types (vectors, geometry, etc.) — uses
            // dynamicAddColumn which sanitizes tableName and applies lock_timeout.
            // colDDL is generated by fieldTypeRegistry (trusted code path).
            await dynamicAddColumn(db, tableName, colDDL);
          });
      }

      // Update fields array in metadata
      const updatedFields = [...(collection.fields || []), field];
      await DDLManager.updateCollectionMetadata(db, name, { fields: updatedFields });

      return c.json({ success: true, field });
    },
  );

  // DELETE /:name/fields/:field — Remove a field
  app.delete('/:name/fields/:field', async (c) => {
    const name = c.req.param('name');
    const fieldName = c.req.param('field');

    const collection = await DDLManager.getCollection(db, name);
    if (!collection) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(name);
    // dynamicDropColumn uses sql.id() for both identifiers and applies lock_timeout.
    await dynamicDropColumn(db, tableName, fieldName);

    const updatedFields = (collection.fields || []).filter((f: any) => f.name !== fieldName);
    await DDLManager.updateCollectionMetadata(db, name, { fields: updatedFields });

    return c.json({ success: true });
  });

  return app;
}
