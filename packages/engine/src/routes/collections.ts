import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Database } from '../db/index.js';
import { DDLManager, CollectionSchema, FieldSchema, SYSTEM_COLUMNS } from '../lib/data/index.js';
// requireInstanceAdmin, not checkPermission(uid,'admin','*'): schema DDL — collections are shared across tenants and isolated by RLS, so creating or altering one is an instance-level operation.
// The tenant_admin policy is ('*','*','*'), so the weak gate matched obj='admin'
// and admitted any delegated tenant admin.
import { getCurrentDomainOrNull, requireInstanceAdmin } from '../lib/tenancy/index.js';
import {
  alterField,
  announceSchemaChange,
  apiKeyMayWatchSchema,
  dropField,
  FieldChangeError,
  schemaChangeRefusal,
  authenticate,
  enqueueDDLJob,
  getDDLJob,
  requestApiKey,
} from '../lib/data/index.js';
import { fieldTypeRegistry } from '../lib/data/index.js';
import {
  dynamicAddColumn,
  dynamicDropColumn,
  dynamicRenameColumn,
  dynamicChangeColumnType,
  dynamicSetColumnRequired,
} from '../db/dynamic.js';
import { resolveConversion } from '../lib/data/index.js';
import { SYSTEM_COLLECTIONS, getSystemCollection } from '../lib/system-collections.js';
import { ddlRateLimit } from '../middleware/rate-limit.js';
import { auditLog } from '../lib/audit.js';
import { z } from 'zod';
import { toJsonb } from '../lib/jsonb.js';
import { virtualList, type VirtualConfig } from '../lib/virtual-collection-adapter.js';
import { guardAdmin } from '../lib/admin-guard.js';

/** FK column lives in the SOURCE table (the collection being modified). */
const RELATION_FK_TYPES = new Set(['m2o', 'reference']);
/** FK column lives in the TARGET table (reverse side: one-to-many). */
const RELATION_REVERSE_TYPES = new Set(['o2m']);
/** All types that require options.related_collection. */
const ALL_RELATION_TYPES = new Set(['m2o', 'reference', 'o2m', 'm2m']);
const ON_DELETE_RE = /^(CASCADE|SET NULL|RESTRICT|NO ACTION)$/;
const SAFE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** A draft virtual source, as the Studio's create form holds it before saving. */
const VirtualTestSchema = z.object({
  source_url: z.string().url(),
  auth_type: z.enum(['none', 'bearer', 'api_key', 'basic']).default('none'),
  auth_value: z.string().optional(),
  list_path: z.string().optional(),
  id_field: z.string().optional(),
  field_mapping: z.record(z.string(), z.string()).optional().default({}),
});

// Reserved system column names — cannot be used as user field names because the
// physical table already owns them. Imported from DDLManager so the routes and
// introspection cannot drift apart (they did: `search_text` was missing here).
const SYSTEM_FIELDS = SYSTEM_COLUMNS;

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function collectionsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // `watchSchema`'s reads — the list and one collection — for an API key holding
  // the explicit `$schema` scope. Path-scoped, GET only: every other door here,
  // `/field-types` included, stays behind the admin gate below.
  const schemaReaders = new WeakSet<Request>();
  const schemaReader: MiddlewareHandler = async (c, next) => {
    if (c.req.method === 'GET' && c.req.param('name') !== 'field-types' && requestApiKey(c)) {
      const principal = await authenticate(c, auth, db);
      if (
        principal?.authType === 'api_key' &&
        apiKeyMayWatchSchema(principal.user.scopes, getCurrentDomainOrNull())
      )
        schemaReaders.add(c.req.raw);
    }
    await next();
  };
  app.use('/', schemaReader);
  app.use('/:name', schemaReader);

  // Admin auth middleware
  app.use('*', async (c, next) => {
    if (schemaReaders.has(c.req.raw)) return next();
    const user = await guardAdmin(c, auth, requireInstanceAdmin);
    if (user instanceof Response) return user;
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
  app.post('/preview', zValidator('json', CollectionSchema), async (c) => {
    const data = c.req.valid('json');
    // Validate field types
    for (const field of data.fields) {
      if (!fieldTypeRegistry.has(field.type)) {
        return c.json({ error: `Unknown field type: "${field.type}"` }, 400);
      }
    }
    const preview = await DDLManager.previewCollection(data);
    return c.json(preview);
  });

  // POST /virtual-test — dial a draft virtual source, from the ENGINE.
  //
  // The Studio used to run this check in the browser: `fetch(source_url, {
  // Authorization: Bearer <token typed in the form> })`. Three things followed
  // from that, and all three are why this endpoint exists.
  //
  //  - It bypassed the SSRF guard completely. `safeFetch` validates the exact
  //    URL and every redirect hop; a browser validates nothing, and the network
  //    it can reach is the ADMINISTRATOR's, not the engine's. `http://192.168.1.1`
  //    typed into that form made the admin's own browser the prober.
  //  - It sent the credential to whatever host was typed, over whatever scheme
  //    was typed, before anything had been saved.
  //  - It could not succeed anyway: a third-party API does not send CORS headers
  //    for a Studio origin, so the browser refused to read the response and the
  //    check reported a network error for sources that were perfectly reachable.
  //    A check that cannot pass teaches people to ignore it.
  //
  // Same adapter the collection itself will use once created, so a green result
  // here means the real read path works — including auth headers, list_path and
  // field mapping.
  app.post('/virtual-test', zValidator('json', VirtualTestSchema), async (c) => {
    const config = c.req.valid('json') as VirtualConfig;
    try {
      const result = await virtualList(config, { page: 1, limit: 1 });
      return c.json({ ok: true, total: result.total, sample: result.data[0] ?? null });
    } catch (err) {
      // The adapter's message already names what failed — an SSRF refusal, a
      // non-2xx from the source, a DNS failure. Passed through rather than
      // flattened into "connection failed".
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST / — Create collection (async via DDL queue)
  app.post('/', zValidator('json', CollectionSchema), async (c) => {
    const data = c.req.valid('json');

    // Validate field types against registry
    for (const field of data.fields) {
      if (!fieldTypeRegistry.has(field.type)) {
        return c.json(
          {
            error: `Unknown field type: "${field.type}". Use GET /api/collections/field-types for available types.`,
          },
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
    const existing = await db
      .selectFrom('zvd_collections')
      .select('name')
      .where('name', '=', data.name)
      .executeTakeFirst();
    if (existing) {
      return c.json({ error: `Collection '${data.name}' already exists` }, 409);
    }

    // Register metadata immediately so GET /:name works without waiting
    // for the DDL job. pg-boss has its own connection pool, so we can't
    // wrap both calls in one Kysely transaction — instead we
    // try-then-rollback: if enqueue fails, delete the metadata row we
    // just inserted to keep zvd_collections in sync with reality.
    let metadataRegistered = false;
    try {
      await DDLManager.registerMetadata(db, data);
      metadataRegistered = true;
      const jobId = await enqueueDDLJob(db, 'create_collection', data);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
      if (metadataRegistered) {
        // Rollback the metadata row so we don't leave a ghost collection
        // visible to GET /api/collections while no physical table exists.
        await db
          .deleteFrom('zvd_collections')
          .where('name', '=', data.name)
          .execute()
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
          .catch((err: any) =>
            console.warn(`[collections] rollback failed for '${data.name}':`, err?.message ?? err),
          );
      }
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 400);
    }
  });

  // POST /:name/sync-schema — Reconcile zvd_collections.fields with the
  // physical table by introspecting information_schema.columns.
  // Useful after a seed migration creates a table outside the DDL queue,
  // which leaves fields=[] and breaks the Studio schema view.
  app.post('/:name/sync-schema', async (c) => {
    const name = c.req.param('name');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    const exists = await DDLManager.tableExists(db, name);
    if (!exists) return c.json({ error: 'Table does not exist' }, 404);
    const count = await DDLManager.syncFieldsFromDB(db, name);
    if (count > 0) {
      announceSchemaChange(name, 'alter');
      await auditLog(db, {
        type: 'settings.changed',
        userId: user?.id,
        resourceId: name,
        resourceType: 'collection_schema',
        metadata: { action: 'sync_fields_from_db', fields_added: count },
      });
    }
    return c.json({
      success: true,
      message:
        count > 0
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
      announceSchemaChange(name, 'alter');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user' as never) as any;
      await auditLog(db, {
        type: 'settings.changed',
        userId: user?.id,
        resourceId: name,
        resourceType: 'collection_metadata',
        metadata: updates,
      });
      return c.json({ success: true });
    },
  );

  // DELETE /:name — Delete collection
  app.delete('/:name', async (c) => {
    const name = c.req.param('name');
    // Use the tenant-scoped DB binding so a request from one tenant can
    // never drop a collection belonging to another.
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const guardError = await assertMutable(name, 'drop');
    if (guardError) return c.json({ error: guardError }, 403);
    const force = c.req.query('force') === 'true';
    try {
      await DDLManager.dropCollection(effectiveDb, name, { force });
      announceSchemaChange(name, 'drop');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
  const assertMutable = (collectionName: string, op: 'add' | 'remove' | 'drop') =>
    schemaChangeRefusal(db, collectionName, op);

  // POST /:name/fields — Add a field to existing collection
  app.post('/:name/fields', zValidator('json', FieldSchema), async (c) => {
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

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    let existingFields: any[];
    try {
      existingFields =
        typeof collection.fields === 'string'
          ? JSON.parse(collection.fields)
          : (collection.fields ?? []);
    } catch {
      existingFields = [];
    }

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    if (existingFields.some((f: any) => f.name === field.name)) {
      return c.json({ error: `Field "${field.name}" already exists in collection "${name}"` }, 409);
    }

    // Every relation type needs a target — if the caller omits it we
    // get a confusing "column X cannot reference NULL" later, so reject
    // here with a clear message instead.
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const opts = (field as any).options ?? {};
    const relatedCollection = opts.related_collection ? String(opts.related_collection) : null;
    if (ALL_RELATION_TYPES.has(field.type) && !relatedCollection) {
      return c.json(
        { error: `Field type "${field.type}" requires options.related_collection` },
        400,
      );
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
      // A plain column is added in the metadata transaction below. The relation
      // branches cannot join it (CREATE INDEX CONCURRENTLY); their DDL is idempotent.
      let colDDL: string | null = null;

      if (RELATION_FK_TYPES.has(field.type) && relatedCollection) {
        // m2o / reference: FK column lives in the SOURCE table. Both
        // helpers delegate to DDLManager so add-field stays in sync
        // with the create-table path's FK semantics.
        const targetTable = DDLManager.getTableName(relatedCollection);
        const onDelete = String(opts.on_delete ?? 'SET NULL').toUpperCase();
        const onUpdate = String(opts.on_update ?? 'CASCADE').toUpperCase();
        await DDLManager.applyRelationFK(
          db,
          tableName,
          field.name,
          targetTable,
          onDelete,
          onUpdate,
        );
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
        await DDLManager.applyRelationFK(
          db,
          targetTable,
          fkColumnInTarget,
          tableName,
          onDelete,
          onUpdate,
        );
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
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        colDDL = fieldTypeRegistry.getColumnDDL(field as any);
      }

      // Row-lock the collection (FOR UPDATE) inside a transaction so
      // two concurrent add-field calls can't both observe the same
      // pre-mutation fields[] and overwrite each other's writes.
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      await db.transaction().execute(async (trx: any) => {
        // Table before metadata row — the order PATCH /:name/fields/:field locks in.
        // dynamicAddColumn applies lock_timeout (2s) to prevent blocking all reads.
        if (colDDL) {
          await dynamicAddColumn(trx, tableName, colDDL);
          await DDLManager.addUniqueKey(trx, tableName, field);
        }
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        const locked = await (trx as any)
          .selectFrom('zvd_collections')
          .select(['fields'])
          .where('name', '=', name)
          .forUpdate()
          .executeTakeFirst();
        if (!locked) throw new Error('Collection not found');
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        let currentFields: any[];
        try {
          currentFields =
            typeof locked.fields === 'string' ? JSON.parse(locked.fields) : (locked.fields ?? []);
        } catch {
          currentFields = [];
        }
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        if (currentFields.some((f: any) => f.name === field.name)) {
          const err = new Error(
            `Field "${field.name}" already exists in collection "${name}"`,
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
          ) as any;
          err.code = 'DUPLICATE';
          throw err;
        }
        const updatedFields = [...currentFields, field];
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        await (trx as any)
          .updateTable('zvd_collections')
          .set({ fields: toJsonb(updatedFields), updated_at: new Date() })
          .where('name', '=', name)
          .execute();
      });
      DDLManager.invalidateCache(name);
      announceSchemaChange(name, 'alter');

      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user' as never) as any;
      await auditLog(db, {
        type: 'settings.changed',
        userId: user?.id,
        resourceId: name,
        resourceType: 'collection_field',
        metadata: { action: 'added', field: { name: field.name, type: field.type } },
      });
      return c.json({ success: true, field });
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    } catch (error: any) {
      if (error?.code === 'DUPLICATE') return c.json({ error: error.message }, 409);
      return c.json({ error: error instanceof Error ? error.message : 'Failed to add field' }, 400);
    }
  });

  // PATCH /:name/fields/:field — Modify a field (rename / change type / toggle required).
  //
  // Body accepts any combination of:
  //   - new_name: string  → ALTER TABLE RENAME COLUMN + sync zvd_relations
  //   - new_type: string  → ALTER COLUMN TYPE + USING expr from
  //                          field-type-conversions.ts
  //   - required: boolean → ALTER COLUMN SET/DROP NOT NULL
  //
  // Operations apply in the order: type → required → rename. Type change
  // first because the USING clause references the *current* column name.
  // Rename last so a downstream error doesn't leave us with a column that
  // has the new name but stale type metadata.
  //
  // Relation fields (m2o, reference, o2m, m2m):
  //   - rename: supported; we also update zvd_relations.source_field.
  //     For m2o/reference the FK column lives on the source table so we
  //     rename it physically; for o2m/m2m the source field is metadata
  //     (the FK lives on the target / junction table) so it's a
  //     metadata-only rename.
  //   - type/required: not supported here. Use the relation-edit flow
  //     for cardinality changes.
  app.patch(
    '/:name/fields/:field',
    zValidator(
      'json',
      z
        .object({
          new_name: z.string().regex(SAFE_NAME_RE, 'lowercase, snake_case').optional(),
          new_type: z
            .string()
            .regex(/^[a-z][a-z0-9_]*$/, 'lowercase identifier')
            .optional(),
          required: z.boolean().optional(),
        })
        .refine(
          (d) => d.new_name !== undefined || d.new_type !== undefined || d.required !== undefined,
          {
            message: 'At least one of new_name, new_type, required must be provided',
          },
        ),
    ),
    async (c) => {
      const { new_name: newName, new_type: newType, required } = c.req.valid('json');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user' as never) as any;
      try {
        const result = await alterField(
          db,
          c.req.param('name'),
          c.req.param('field'),
          { newName, newType, required },
          user?.id,
        );
        return c.json({ success: true, ...result });
      } catch (error) {
        if (error instanceof FieldChangeError)
          return c.json({ error: error.message }, error.status);
        return c.json(
          { error: error instanceof Error ? error.message : 'Failed to modify field' },
          400,
        );
      }
    },
  );

  // DELETE /:name/fields/:field — Remove a field
  app.delete('/:name/fields/:field', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user' as never) as any;
    try {
      await dropField(db, c.req.param('name'), c.req.param('field'), user?.id);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof FieldChangeError) return c.json({ error: error.message }, error.status);
      return c.json(
        { error: error instanceof Error ? error.message : 'Failed to delete field' },
        400,
      );
    }
  });

  return app;
}
