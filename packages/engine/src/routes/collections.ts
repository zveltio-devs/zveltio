import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Database } from '../db/index.js';
import { DDLManager, CollectionSchema, FieldSchema } from '../lib/ddl-manager.js';
import { checkPermission } from '../lib/permissions.js';
import { enqueueDDLJob, getDDLJob } from '../lib/ddl-queue.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { dynamicAddColumn, dynamicDropColumn } from '../db/dynamic.js';
import { SYSTEM_COLLECTIONS, getSystemCollection } from '../lib/system-collections.js';
import { ddlRateLimit } from '../middleware/rate-limit.js';
import { auditLog } from '../lib/audit.js';
import { z } from 'zod';

/** FK column lives in the SOURCE table (the collection being modified). */
const RELATION_FK_TYPES = new Set(['m2o', 'reference']);
/** FK column lives in the TARGET table (reverse side: one-to-many). */
const RELATION_REVERSE_TYPES = new Set(['o2m']);
/** All types that require options.related_collection. */
const ALL_RELATION_TYPES = new Set(['m2o', 'reference', 'o2m', 'm2m']);
const ON_DELETE_RE = /^(CASCADE|SET NULL|RESTRICT|NO ACTION)$/;
const SAFE_NAME_RE = /^[a-z][a-z0-9_]*$/;

// Reserved system column names — cannot be used as user field names because the
// physical table already owns them (see DDLManager.createCollection). Declared at
// module scope so both CREATE-collection and ADD-field paths use the same list.
const SYSTEM_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'status', 'created_by', 'updated_by', 'search_vector',
]);

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

  // DDL rate limit: applies only to write methods (schema changes) — max 10/minute
  // GET requests (listing/reading schema) are exempt so studio navigation isn't blocked
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/', ddlRateLimit);
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/:name', ddlRateLimit);
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/:name/fields', ddlRateLimit);
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/:name/fields/:fieldName', ddlRateLimit);

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

  // POST /preview — dry-run: returns DDL SQL without executing it
  app.post(
    '/preview',
    zValidator('json', CollectionSchema),
    async (c) => {
      const data = c.req.valid('json');
      // Validate field types
      for (const field of data.fields) {
        if (!fieldTypeRegistry.has(field.type)) {
          return c.json({ error: `Unknown field type: "${field.type}"` }, 400);
        }
      }
      const preview = await DDLManager.previewCollection(data);
      return c.json(preview);
    },
  );

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
        // Block reserved system column names before enqueueing DDL — otherwise the
        // async job fails with "column X specified more than once" and leaves orphan
        // metadata in zvd_collections (ghost collection).
        if (SYSTEM_FIELDS.has(field.name)) {
          return c.json(
            { error: `Field name '${field.name}' is reserved (conflicts with system column).` },
            400,
          );
        }
      }

      // Reject duplicate names immediately
      const existing = await (db as any)
        .selectFrom('zvd_collections')
        .select('name')
        .where('name', '=', data.name)
        .executeTakeFirst();
      if (existing) {
        return c.json({ error: `Collection '${data.name}' already exists` }, 409);
      }

      try {
        // Register metadata immediately so GET /:name works without waiting for DDL job
        await DDLManager.registerMetadata(db, data);
        const jobId = await enqueueDDLJob(db, 'create_collection', data);
        const user = c.get('user') as any;
        await auditLog(db, {
          type: 'collection.created',
          userId: user?.id,
          resourceId: data.name,
          resourceType: 'collection',
          metadata: { name: data.name, fields: data.fields?.length ?? 0 },
        });
        return c.json(
          {
            success: true,
            message: `Collection '${data.name}' is being created`,
            name: data.name,
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

  // POST /:name/sync-schema — Reconcile zvd_collections.fields with the
  // physical table by introspecting information_schema.columns.
  // Useful after a seed migration creates a table outside the DDL queue,
  // which leaves fields=[] and breaks the Studio schema view.
  app.post('/:name/sync-schema', async (c) => {
    const name = c.req.param('name');
    const exists = await DDLManager.tableExists(db, name);
    if (!exists) return c.json({ error: 'Table does not exist' }, 404);
    const count = await DDLManager.syncFieldsFromDB(db, name);
    return c.json({
      success: true,
      message: count > 0
        ? `Populated ${count} field(s) for '${name}' from physical schema`
        : `No sync needed — '${name}' already has fields metadata`,
      synced: count,
    });
  });

  // GET /jobs/:jobId — Check DDL job status
  app.get('/jobs/:jobId', async (c) => {
    const job = await getDDLJob(db, c.req.param('jobId'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json({ job });
  });

  // GET /:name — Get collection details.
  // Falls back to SYSTEM_COLLECTIONS for Better-Auth tables (user, session, …)
  // so Studio's detail view is consistent with the list endpoint.
  app.get('/:name', async (c) => {
    const name = c.req.param('name');
    const collection = await DDLManager.getCollection(db, name);
    if (collection) return c.json({ collection });

    const system = getSystemCollection(name);
    if (system) {
      return c.json({
        collection: {
          name: system.name,
          display_name: system.displayName,
          icon: system.icon,
          is_system: true,
          readonly: system.readonly,
          fields: system.fields,
        },
      });
    }
    return c.json({ error: 'Collection not found' }, 404);
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
    // M4 FIX: Use tenant-scoped DB so cross-tenant collection deletion is impossible.
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const guardError = await assertMutable(name, 'drop');
    if (guardError) return c.json({ error: guardError }, 403);
    const force = c.req.query('force') === 'true';
    try {
      await DDLManager.dropCollection(effectiveDb, name, { force });
      const user = c.get('user') as any;
      await auditLog(db, {
        type: 'collection.deleted',
        userId: user?.id,
        resourceId: name,
        resourceType: 'collection',
        metadata: { name },
      });
      return c.json({ success: true, message: `Collection '${name}' deleted` });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 400);
    }
  });

  // BYOD guard: schema mutations are not allowed on unmanaged collections.
  // ddl-queue.ts enforces the same rule for async DDL jobs; this keeps the sync HTTP
  // paths (add_field / remove_field / drop) from silently diverging.
  // `drop`-type ops additionally respect schema_locked for the core/system tables.
  async function assertMutable(
    collectionName: string,
    op: 'add' | 'remove' | 'drop',
  ): Promise<string | null> {
    const meta = await (db as any)
      .selectFrom('zvd_collections')
      .select(['is_managed', 'schema_locked'])
      .where('name', '=', collectionName)
      .executeTakeFirst();
    if (!meta) return null; // collection-not-found is handled by caller
    if (meta.is_managed === false) {
      return `Collection '${collectionName}' is unmanaged (BYOD). Schema changes are not allowed.`;
    }
    if (meta.schema_locked === true && op !== 'add') {
      return `Collection '${collectionName}' is schema-locked. ${op === 'drop' ? 'Dropping' : 'Removing fields from'} it is not allowed.`;
    }
    return null;
  }

  // POST /:name/fields — Add a field to existing collection
  app.post(
    '/:name/fields',
    zValidator('json', FieldSchema),
    async (c) => {
      const name = c.req.param('name');
      const field = c.req.valid('json');

      if (SYSTEM_FIELDS.has(field.name)) {
        return c.json({ error: `"${field.name}" is a reserved system field name` }, 400);
      }

      if (!fieldTypeRegistry.has(field.type)) {
        return c.json({ error: `Unknown field type: "${field.type}"` }, 400);
      }

      const collection = await DDLManager.getCollection(db, name);
      if (!collection) return c.json({ error: 'Collection not found' }, 404);

      const guardError = await assertMutable(name, 'add');
      if (guardError) return c.json({ error: guardError }, 403);

      let existingFields: any[];
      try {
        existingFields = typeof collection.fields === 'string'
          ? JSON.parse(collection.fields)
          : (collection.fields ?? []);
      } catch {
        existingFields = [];
      }

      if (existingFields.some((f: any) => f.name === field.name)) {
        return c.json({ error: `Field "${field.name}" already exists in collection "${name}"` }, 409);
      }

      // Bug #4: validate related_collection required for all relation types
      const opts = (field as any).options ?? {};
      const relatedCollection = opts.related_collection ? String(opts.related_collection) : null;
      if (ALL_RELATION_TYPES.has(field.type) && !relatedCollection) {
        return c.json({ error: `Field type "${field.type}" requires options.related_collection` }, 400);
      }

      // Validate relation target upfront (fail-fast with proper HTTP codes before DDL)
      if (relatedCollection) {
        if (!SAFE_NAME_RE.test(relatedCollection)) {
          return c.json({ error: `Invalid target collection: '${relatedCollection}'` }, 400);
        }
        const targetExists = await DDLManager.tableExists(db, relatedCollection);
        if (!targetExists) {
          return c.json({ error: `Target collection '${relatedCollection}' not found` }, 404);
        }
        const onDelete = String(opts.on_delete ?? 'SET NULL').toUpperCase();
        const onUpdate = String(opts.on_update ?? 'CASCADE').toUpperCase();
        if (!ON_DELETE_RE.test(onDelete) || !ON_DELETE_RE.test(onUpdate)) {
          return c.json({ error: 'Invalid on_delete/on_update value' }, 400);
        }
      }

      try {
        const tableName = DDLManager.getTableName(name);

        if (RELATION_FK_TYPES.has(field.type) && relatedCollection) {
          // Bug #5: m2o/reference — FK column in source table, use shared DDLManager helpers
          const targetTable = DDLManager.getTableName(relatedCollection);
          const onDelete = String(opts.on_delete ?? 'SET NULL').toUpperCase();
          const onUpdate = String(opts.on_update ?? 'CASCADE').toUpperCase();
          await DDLManager.applyRelationFK(db, tableName, field.name, targetTable, onDelete, onUpdate);
          await DDLManager.registerRelation(db, {
            name: `${name}_${field.name}`,
            type: 'm2o',
            source_collection: name,
            source_field: field.name,
            target_collection: relatedCollection,
            target_field: 'id',
            on_delete: onDelete,
            on_update: onUpdate,
          });

        } else if (RELATION_REVERSE_TYPES.has(field.type) && relatedCollection) {
          // o2m — FK column lives in TARGET table (target has many of source)
          const targetTable = DDLManager.getTableName(relatedCollection);
          const fkColumnInTarget = `${name}_id`;
          const onDelete = String(opts.on_delete ?? 'SET NULL').toUpperCase();
          const onUpdate = String(opts.on_update ?? 'CASCADE').toUpperCase();
          await DDLManager.applyRelationFK(db, targetTable, fkColumnInTarget, tableName, onDelete, onUpdate);
          await DDLManager.registerRelation(db, {
            name: `${name}_${field.name}`,
            type: 'o2m',
            source_collection: name,
            source_field: field.name,
            target_collection: relatedCollection,
            target_field: fkColumnInTarget,
            on_delete: onDelete,
            on_update: onUpdate,
          });

        } else if (field.type === 'm2m' && relatedCollection) {
          // m2m — junction table with FK columns for both sides
          const junctionTable = await DDLManager.createJunctionTable(db, name, relatedCollection);
          await DDLManager.registerRelation(db, {
            name: `${name}_${field.name}`,
            type: 'm2m',
            source_collection: name,
            source_field: field.name,
            target_collection: relatedCollection,
            target_field: 'id',
            junction_table: junctionTable,
          });

        } else {
          const colDDL = fieldTypeRegistry.getColumnDDL(field as any);
          if (colDDL) {
            // dynamicAddColumn applies lock_timeout (2s) to prevent blocking all reads.
            await dynamicAddColumn(db, tableName, colDDL);
          }
        }

        // Bug #6 + #8: lock the collection row atomically to prevent concurrent
        // field additions from producing duplicate field metadata.
        await (db as any).transaction().execute(async (trx: any) => {
          const locked = await (trx as any)
            .selectFrom('zvd_collections')
            .select(['fields'])
            .where('name', '=', name)
            .forUpdate()
            .executeTakeFirst();
          if (!locked) throw new Error('Collection not found');
          let currentFields: any[];
          try {
            currentFields = typeof locked.fields === 'string'
              ? JSON.parse(locked.fields)
              : (locked.fields ?? []);
          } catch {
            currentFields = [];
          }
          if (currentFields.some((f: any) => f.name === field.name)) {
            const err = new Error(`Field "${field.name}" already exists in collection "${name}"`) as any;
            err.code = 'DUPLICATE';
            throw err;
          }
          const updatedFields = [...currentFields, field];
          await (trx as any)
            .updateTable('zvd_collections')
            .set({ fields: JSON.stringify(updatedFields), updated_at: new Date() })
            .where('name', '=', name)
            .execute();
        });
        DDLManager.invalidateCache(name);

        return c.json({ success: true, field });
      } catch (error: any) {
        if (error?.code === 'DUPLICATE') return c.json({ error: error.message }, 409);
        return c.json({ error: error instanceof Error ? error.message : 'Failed to add field' }, 400);
      }
    },
  );

  // DELETE /:name/fields/:field — Remove a field
  app.delete('/:name/fields/:field', async (c) => {
    const name = c.req.param('name');
    const fieldName = c.req.param('field');

    if (!/^[a-z][a-z0-9_]*$/.test(fieldName)) {
      return c.json({ error: 'Invalid field name' }, 400);
    }

    const collection = await DDLManager.getCollection(db, name);
    if (!collection) return c.json({ error: 'Collection not found' }, 404);

    const guardError = await assertMutable(name, 'remove');
    if (guardError) return c.json({ error: guardError }, 403);

    let existingFields: any[];
    try {
      existingFields = typeof collection.fields === 'string'
        ? JSON.parse(collection.fields)
        : (collection.fields ?? []);
    } catch {
      existingFields = [];
    }

    if (!existingFields.some((f: any) => f.name === fieldName)) {
      return c.json({ error: `Field "${fieldName}" not found in collection "${name}"` }, 404);
    }

    try {
      const tableName = DDLManager.getTableName(name);
      const fieldDef = existingFields.find((f: any) => f.name === fieldName);

      if (fieldDef?.type === 'o2m') {
        // o2m: FK column lives in TARGET table — look up and drop it there
        const relation = await (db as any)
          .selectFrom('zvd_relations')
          .select(['target_collection', 'target_field'])
          .where('source_collection', '=', name)
          .where('source_field', '=', fieldName)
          .executeTakeFirst();
        if (relation?.target_collection && relation?.target_field) {
          const targetTable = DDLManager.getTableName(relation.target_collection);
          await dynamicDropColumn(db, targetTable, relation.target_field);
        }
      } else if (fieldDef?.type === 'm2m') {
        // m2m: drop the junction table (no column in source table)
        const relation = await (db as any)
          .selectFrom('zvd_relations')
          .select(['junction_table'])
          .where('source_collection', '=', name)
          .where('source_field', '=', fieldName)
          .executeTakeFirst();
        if (relation?.junction_table) {
          await DDLManager.dropJunctionTable(db, relation.junction_table);
        }
      } else {
        await dynamicDropColumn(db, tableName, fieldName);
      }

      // Drop the relation row (dangling metadata causes re-add to hit UNIQUE constraint)
      await (db as any)
        .deleteFrom('zvd_relations')
        .where('source_collection', '=', name)
        .where('source_field', '=', fieldName)
        .execute()
        .catch((err: any) => console.warn(`[remove-field] zvd_relations cleanup:`, err?.message ?? err));

      const updatedFields = existingFields.filter((f: any) => f.name !== fieldName);
      await DDLManager.updateCollectionMetadata(db, name, { fields: updatedFields });

      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to delete field' }, 400);
    }
  });

  return app;
}
