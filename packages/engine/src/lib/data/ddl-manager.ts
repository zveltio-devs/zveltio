import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'kysely';
import { indexName, pgIdentifier } from '../pg-identifier.js';
import { z } from 'zod';
import type { Database } from '../../db/index.js';
import { fieldTypeRegistry, renderSqlDefault, type FieldConfig } from './field-type-registry.js';
import { buildTenantUniqueIndex, findTenantUniqueIndex } from './unique-key-reconcile.js';
import { toJsonb } from '../jsonb.js';
import { invalidateRulesCache } from '../validation-engine.js';

// ─── Relation type sets ───────────────────────────────────────────────────────
/** FK column lives in the SOURCE table (the collection being modified). */
const RELATION_FK_TYPES = new Set(['m2o', 'reference']);
const ON_DELETE_SAFE = new Set(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']);
const SAFE_NAME_RE = /^[a-z][a-z0-9_]*$/;

// ─── Safe DDL helpers ─────────────────────────────────────────────────────────

async function withLockTimeout(
  db: Database,
  fn: (trx: Database) => Promise<void>,
  timeout = '2s',
): Promise<void> {
  if (!/^\d+(\.\d+)?(ms|s|min)$/.test(timeout)) {
    throw new Error(
      `Invalid lock_timeout format: "${timeout}". Expected format: "2s", "500ms", "1min".`,
    );
  }
  // Same short-circuit as the twin in `db/dynamic.ts`, and for the same reason:
  // three of the five DDL queue handlers hand a transaction handle to this
  // manager, and Kysely refuses a nested `.transaction()` outright — "calling
  // the transaction method for a Transaction is not supported". Those handlers
  // threw before emitting a statement.
  //
  // `SET LOCAL` is transaction-scoped either way, so the caller's transaction
  // gets the timeout it asked for.
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) {
    await sql.raw(`SET LOCAL lock_timeout = '${timeout}'`).execute(db);
    await fn(db);
    return;
  }

  await db.transaction().execute(async (trx: Database) => {
    await sql.raw(`SET LOCAL lock_timeout = '${timeout}'`).execute(trx);
    await fn(trx);
  });
}

/** The trigger that records a collection's deletes for sync pull (migration 032). */
function syncTombstoneTrigger(tableName: string): string {
  return (
    `CREATE TRIGGER zv_sync_tombstone AFTER DELETE ON ${tableName} ` +
    'REFERENCING OLD TABLE AS zv_old_rows FOR EACH STATEMENT EXECUTE FUNCTION zveltio_sync_tombstone()'
  );
}

/** `nonCollectionObjects`, resolved where the engine keeps its extensions. */
async function nonCollectionObjectsNow(db: Database): Promise<Set<string>> {
  const [{ nonCollectionObjects }, { resolveExtensionsBase }] = await Promise.all([
    import('../tenancy/index.js'),
    import('../extensions/index.js'),
  ]);
  return nonCollectionObjects(db, resolveExtensionsBase());
}

/**
 * The tables holding rules that name a field by its column: column permissions,
 * row rules, validation rules — as (table, collection column, field column).
 */
export const FIELD_RULE_TABLES = [
  ['zvd_column_permissions', 'collection_name', 'column_name'],
  ['zvd_rls_policies', 'collection', 'filter_field'],
  ['zv_validation_rules', 'collection', 'field_name'],
] as const;

/** Field types whose values feed a collection's full-text search. */
export const SEARCH_FIELD_TYPES = new Set(['text', 'richtext', 'email']);

/**
 * The body of `<table>_search_trigger()`.
 *
 * Fields are read from `to_jsonb(NEW)` by key, never as `NEW."field"`. PL/pgSQL
 * resolves `NEW."field"` when the row is written, so once a column was dropped
 * or renamed — by removeField, the field routes, a schema-branch merge — every
 * INSERT and UPDATE on the collection failed with `record "new" has no field`,
 * and the collection could no longer be written at all. A missing key reads as
 * NULL instead.
 */
function searchTriggerBody(fields: string[], withVector: boolean, withText: boolean): string {
  const value = (f: string) => `coalesce(r->>'${f}', '')`;
  const lines: string[] = [];
  if (withVector) {
    const weights = fields
      .map((f, i) => `setweight(to_tsvector('english', ${value(f)}), '${'ABCD'[Math.min(i, 3)]}')`)
      .join(' || ');
    lines.push(`NEW.search_vector := ${weights};`);
  }
  // concat_ws skips NULLs, so an empty field adds no stray separator.
  if (withText) {
    lines.push(`NEW.search_text := concat_ws(' ', ${fields.map((f) => `r->>'${f}'`).join(', ')});`);
  }
  return `
DECLARE r jsonb := to_jsonb(NEW);
BEGIN
  ${lines.join('\n  ')}
  RETURN NEW;
END
`;
}

// Every collection table starts with these; createCollection and its preview
// share them so the preview cannot drift from what is created.
const SYSTEM_COLUMN_DDL: readonly string[] = [
  'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
  'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived'))",
  'created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL',
  'updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL',
  // Multi-tenant: every row belongs to a tenant, defaulted from the request
  // GUC (or the default tenant). The boot/RLS-on-create reconciler then
  // FORCE-RLS's this table on tenant_id. See tenant-manager.applyTenantRLS.
  "tenant_id UUID NOT NULL DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid)",
];

/** CONCURRENTLY builds held back by `deferIndexBuilds`. */
const heldIndexBuilds = new AsyncLocalStorage<string[]>();

/**
 * An index build; CONCURRENTLY unless the table is the one the caller just
 * created. Inside `deferIndexBuilds` a CONCURRENTLY build is queued instead: it
 * waits for every older transaction in the database, so one started while an
 * extension's request transaction is open waits on that request, which is
 * waiting on it (measured: virtualxid, until the pool gave up).
 */
async function buildIndex(db: Database, ddl: string, concurrently = true): Promise<void> {
  const stmt = concurrently ? toConcurrentIndex(ddl) : ddl;
  const held = concurrently ? heldIndexBuilds.getStore() : undefined;
  if (held) held.push(stmt);
  else await sql.raw(stmt).execute(db);
}

/** Run `fn`, returning the CONCURRENTLY builds it asked for instead of running them. */
export async function deferIndexBuilds<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; indexes: string[] }> {
  const indexes: string[] = [];
  const result = await heldIndexBuilds.run(indexes, fn);
  return { result, indexes };
}

function toConcurrentIndex(indexSQL: string): string {
  return indexSQL.replace(
    /^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)(?!CONCURRENTLY\s)/i,
    '$1CONCURRENTLY ',
  );
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Physical columns every collection table owns (see `createCollection`), so no
 * user field may claim one. Single source of truth: the collections routes
 * reject these names on create/add/rename/remove, and `introspectTable` skips
 * them. `search_text` was missing from the routes' copy of this list, so a user
 * field with that name was accepted and then silently overwritten by the FTS
 * trigger on every write.
 */
export const SYSTEM_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'created_at',
  'updated_at',
  'status',
  'created_by',
  'updated_by',
  'tenant_id',
  'search_vector',
  'search_text',
]);

export const FieldSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      'Field name must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
    ),
  type: z.string().max(50),
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  indexed: z.boolean().default(false),
  defaultValue: z.any().optional(),
  options: z
    .record(
      z.string().max(100),
      z.union([z.string().max(10_000), z.number(), z.boolean(), z.null(), z.array(z.any())]),
    )
    .optional(),
  label: z.string().max(200).optional(),
  description: z.string().max(1_000).optional(),
  encrypted: z.boolean().default(false).optional(),
});

// Accept both camelCase (TS-style) and snake_case (REST-style) for client
// convenience. The transform below normalizes everything to camelCase before
// the rest of the codebase sees it.
export const CollectionSchema = z.preprocess(
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  (raw: any) => {
    if (!raw || typeof raw !== 'object') return raw;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const o: any = { ...raw };
    // snake → camel aliasing
    if (o.display_name != null && o.displayName == null) o.displayName = o.display_name;
    if (o.route_group != null && o.routeGroup == null) o.routeGroup = o.route_group;
    if (o.is_permissioned != null && o.isPermissioned == null) o.isPermissioned = o.is_permissioned;
    if (o.singular_name != null && o.singularName == null) o.singularName = o.singular_name;
    if (o.ai_search_enabled != null && o.aiSearchEnabled == null)
      o.aiSearchEnabled = o.ai_search_enabled;
    if (o.ai_search_field != null && o.aiSearchField == null) o.aiSearchField = o.ai_search_field;
    if (o.is_managed != null && o.isManaged == null) o.isManaged = o.is_managed;
    if (o.is_system != null && o.isSystem == null) o.isSystem = o.is_system;
    if (o.schema_locked != null && o.schemaLocked == null) o.schemaLocked = o.schema_locked;
    return o;
  },
  z.object({
    name: z
      .string()
      .max(63, 'Collection name must be at most 63 characters (PostgreSQL identifier limit)')
      .regex(
        /^[a-z][a-z0-9_]*$/,
        'Collection name must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
      ),
    displayName: z.string().optional(),
    icon: z.string().optional(),
    routeGroup: z.enum(['public', 'partners', 'private', 'admin']).optional(),
    isPermissioned: z.boolean().optional(),
    sort: z.number().int().min(0).optional(),
    // Upper bound because Postgres has one: a table can hold at most 1600
    // columns, and the engine adds its own (id, tenant_id, status, created_at,
    // created_by, updated_at, updated_by, …) on top of whatever is declared.
    //
    // Without it the API answered 202 "being created" to a definition Postgres
    // could never accept, the DDL job failed with SQLSTATE 54011, and pg-boss
    // put it into `retry` — re-running a deterministic failure on a schedule.
    // The operator saw a collection that never appeared and no error anywhere
    // they would look. Measured live with 2000 fields.
    //
    // 1400 rather than 1600: it has to be wrong in the safe direction, since
    // the system columns are added after this check and a collection that
    // validates here must be creatable.
    fields: z.array(FieldSchema).min(1).max(1400),
    description: z.string().optional(),
    singularName: z.string().optional(),
    aiSearchEnabled: z.boolean().optional(),
    aiSearchField: z.string().nullable().optional(),
    isManaged: z.boolean().optional(),
    isSystem: z.boolean().optional(),
    schemaLocked: z.boolean().optional(),
  }),
);

export type CollectionDefinition = z.infer<typeof CollectionSchema>;

// ─── In-memory metadata cache ──────────────────────────────────────────────────

const METADATA_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  data: any;
  ts: number;
}

const collectionCache = new Map<string, CacheEntry>();
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
let _collectionsListCache: { data: any[]; ts: number } | null = null;
let _cacheGen = 0;

export class DDLManager {
  static getTableName(collectionName: string): string {
    return `zvd_${collectionName}`;
  }

  static invalidateCache(name?: string): void {
    _cacheGen++;
    if (name) {
      collectionCache.delete(name);
    } else {
      collectionCache.clear();
    }
    _collectionsListCache = null;
  }

  static async tableExists(db: Database, collectionName: string): Promise<boolean> {
    const tableName = this.getTableName(collectionName);
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename = ${tableName}
      ) as exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  }

  // ── Shared relation helpers ──────────────────────────────────────────────────

  /**
   * Adds a UUID FK column to `tableName` referencing `targetTable(id)` with
   * lock_timeout, then creates a CONCURRENTLY index on it.
   *
   * Must be called OUTSIDE an open transaction — and that is now checked rather
   * than only written down. `CREATE INDEX CONCURRENTLY` inside a transaction
   * block raises SQLSTATE 25001 several statements after the mistake, which
   * reads as a database problem rather than a call in the wrong place. The
   * comment has been here since the method was written and did not stop the DDL
   * queue handing this a transaction handle.
   */
  static async applyRelationFK(
    db: Database,
    tableName: string,
    fieldName: string,
    targetTable: string,
    onDelete = 'SET NULL',
    onUpdate = 'CASCADE',
    /** False from `createCollection`, for the table it just made; see the note there. */
    concurrently = true,
  ): Promise<void> {
    if ((db as unknown as { isTransaction?: boolean }).isTransaction) {
      throw new Error(
        'DDLManager.applyRelationFK must run on the pool, not inside a transaction: ' +
          'it issues CREATE INDEX CONCURRENTLY, which PostgreSQL refuses in a ' +
          'transaction block (SQLSTATE 25001).',
      );
    }
    // The three identifiers below are interpolated into a `sql.raw` template.
    // `onDelete` / `onUpdate` were already checked against an allow-list; the
    // names were not, and a name is the easier thing for a caller to get wrong.
    for (const n of [tableName, fieldName, targetTable]) {
      if (!SAFE_NAME_RE.test(n)) {
        throw new Error(`Unsafe identifier for a relation FK: "${n}"`);
      }
    }

    const od = onDelete.toUpperCase();
    const ou = onUpdate.toUpperCase();
    if (!ON_DELETE_SAFE.has(od) || !ON_DELETE_SAFE.has(ou)) {
      throw new Error(`Invalid on_delete/on_update value: ${od}/${ou}`);
    }
    await withLockTimeout(db, async (trx) => {
      await sql
        .raw(
          `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${fieldName}" UUID ` +
            `REFERENCES "${targetTable}"(id) ON DELETE ${od} ON UPDATE ${ou}`,
        )
        .execute(trx);
    });
    // Index the FK column for join performance
    await buildIndex(
      db,
      `CREATE INDEX IF NOT EXISTS ${indexName(tableName, fieldName)} ON "${tableName}"("${fieldName}")`,
      concurrently,
    );
  }

  /** Inserts a row into zvd_relations. Idempotent via ON CONFLICT DO NOTHING. */
  static async registerRelation(
    db: Database,
    rel: {
      name: string;
      type: string;
      source_collection: string;
      source_field: string;
      target_collection: string;
      target_field: string;
      on_delete?: string;
      on_update?: string;
      junction_table?: string;
    },
  ): Promise<void> {
    await db
      .insertInto('zvd_relations')
      .values(rel)
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      .onConflict((oc: any) => oc.doNothing())
      .execute()
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      .catch((err: any) => console.warn('[registerRelation]', err?.message ?? err));
  }

  /** Drops a m2m junction table by its full name. Validates the name is a safe zvd_jnc_ table. */
  static async dropJunctionTable(db: Database, junctionTable: string): Promise<void> {
    if (!/^zvd_jnc_[a-z][a-z0-9_]*$/.test(junctionTable)) {
      throw new Error(`Invalid junction table name: "${junctionTable}"`);
    }
    await withLockTimeout(db, async (trx) => {
      await sql.raw(`DROP TABLE IF EXISTS "${junctionTable}" CASCADE`).execute(trx);
    });
  }

  /**
   * Creates a m2m junction table `zvd_jnc_{sourceName}_{targetName}` with FK columns
   * for both sides, plus plain indexes for join performance: the table is the one
   * this call creates (IF NOT EXISTS only makes a retry idempotent). Not
   * CONCURRENTLY — a concurrent build waits on every open transaction, and one
   * still running when the next request dropped the junction waited on that
   * request while its DROP waited on the build (55P03 after lock_timeout).
   * Returns the junction table name.
   */
  static async createJunctionTable(
    db: Database,
    sourceName: string,
    targetName: string,
  ): Promise<string> {
    // Validated here, not only in the caller. Both names are interpolated into
    // identifiers below, and `createCollection` happens to test `target` before
    // calling — which protects this call and not the next one somebody writes.
    // The check belongs where the interpolation is.
    for (const n of [sourceName, targetName]) {
      if (!SAFE_NAME_RE.test(n)) {
        throw new Error(`Unsafe collection name for a junction table: "${n}"`);
      }
    }

    const sourceTable = this.getTableName(sourceName);
    const targetTable = this.getTableName(targetName);
    const junctionTable = pgIdentifier(`zvd_jnc_${sourceName}_${targetName}`);
    await sql
      .raw(
        `CREATE TABLE IF NOT EXISTS "${junctionTable}" (` +
          `id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ` +
          `"${sourceName}_id" UUID REFERENCES "${sourceTable}"(id) ON DELETE CASCADE, ` +
          `"${targetName}_id" UUID REFERENCES "${targetTable}"(id) ON DELETE CASCADE, ` +
          `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` +
          `)`,
      )
      .execute(db);
    await buildIndex(
      db,
      `CREATE INDEX IF NOT EXISTS ${indexName(junctionTable, 'src')} ON "${junctionTable}"("${sourceName}_id")`,
      false,
    );
    await buildIndex(
      db,
      `CREATE INDEX IF NOT EXISTS ${indexName(junctionTable, 'tgt')} ON "${junctionTable}"("${targetName}_id")`,
      false,
    );
    // The links are tenant rows: the collection tables' tenant_id, policy and
    // narrow-role grants. Without them any tenant read and deleted every other
    // tenant's links (migration 042). Not best-effort — an unisolated junction
    // is a cross-tenant table, and the CREATE above is idempotent for a retry.
    const { applyTenantRLS } = await import('../tenancy/index.js');
    await applyTenantRLS(db, junctionTable);
    return junctionTable;
  }

  // ── createCollection ─────────────────────────────────────────────────────────

  static async createCollection(db: Database, definition: CollectionDefinition): Promise<void> {
    const validated = CollectionSchema.parse(definition);
    const reserved = await this.reservedName(db, validated.name);
    if (reserved) throw new Error(reserved);

    for (const field of validated.fields) {
      if (!fieldTypeRegistry.has(field.type)) {
        throw new Error(
          `Unknown field type: "${field.type}". Available types: ${fieldTypeRegistry.list().join(', ')}`,
        );
      }
      if (RELATION_FK_TYPES.has(field.type) && !field.options?.related_collection) {
        throw new Error(
          `Field "${field.name}" (${field.type}) requires options.related_collection.`,
        );
      }
    }

    const tableName = this.getTableName(validated.name);

    const SAFE_TABLE_RE = /^zvd_[a-z][a-z0-9_]*$/;
    if (!SAFE_TABLE_RE.test(tableName)) {
      throw new Error(`Invalid table name: "${tableName}".`);
    }

    if (await this.tableExists(db, validated.name)) {
      throw new Error(`Collection '${validated.name}' already exists`);
    }

    // Relation FK columns are added AFTER the table exists — we need the
    // target table present before we can declare a foreign key against it.
    const relationFields = validated.fields.filter(
      (f) => RELATION_FK_TYPES.has(f.type) && f.options?.related_collection,
    );
    const regularFields = validated.fields.filter(
      (f) => !RELATION_FK_TYPES.has(f.type) || !f.options?.related_collection,
    );

    const columns: string[] = [...SYSTEM_COLUMN_DDL];
    const uniqueKeys: string[] = [];

    // Not CONCURRENTLY: every index here, and in the helpers called below with
    // `concurrently` false, is on a table this call created moments ago, empty.
    // A concurrent build waits for every older transaction in the database
    // first — including the request of an extension that creates a collection
    // and fills it (ai-alchemist), which held the build forever (virtualxid).
    const indexes: string[] = [
      `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'created_at')} ON ${tableName}(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'status')} ON ${tableName}(status)`,
    ];

    const ALLOWED_PG_EXTENSIONS = new Set([
      'pgvector',
      'postgis',
      'postgis_topology',
      'uuid-ossp',
      'pg_trgm',
      'unaccent',
      'btree_gist',
      'btree_gin',
      'hstore',
      'citext',
      'intarray',
      'fuzzystrmatch',
    ]);

    const requiredExtensions = fieldTypeRegistry.getRequiredExtensions(
      regularFields as FieldConfig[],
    );
    for (const ext of requiredExtensions) {
      if (!ALLOWED_PG_EXTENSIONS.has(ext)) {
        throw new Error(
          `PostgreSQL extension "${ext}" is not in the allowed extensions whitelist.`,
        );
      }
      await sql`CREATE EXTENSION IF NOT EXISTS ${sql.id(ext)}`.execute(db);
    }

    for (const field of regularFields) {
      const colDDL = fieldTypeRegistry.getColumnDDL(field as FieldConfig);
      if (!colDDL) continue;
      columns.push(colDDL);
      const uniqueKey = fieldTypeRegistry.getUniqueKeyDDL(field as FieldConfig);
      if (uniqueKey) uniqueKeys.push(uniqueKey);
      const indexDDL = fieldTypeRegistry.getIndexDDL(tableName, field as FieldConfig);
      if (indexDDL) indexes.push(indexDDL);
      // The tenant-first form beside it — the one a tenant-scoped read can use.
      const tenantIndexDDL = fieldTypeRegistry.getTenantIndexDDL(tableName, field as FieldConfig);
      if (tenantIndexDDL) indexes.push(tenantIndexDDL);
    }

    // Table constraints after every column, as CREATE TABLE has them.
    columns.push(...uniqueKeys);
    await sql.raw(`CREATE TABLE ${tableName} (\n  ${columns.join(',\n  ')}\n)`).execute(db);

    for (const indexSQL of indexes) {
      await sql.raw(indexSQL).execute(db);
    }

    // FTS support; the text half and the trigger follow the metadata below.
    await withLockTimeout(db, async (trx) => {
      await sql
        .raw(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS search_vector tsvector`)
        .execute(trx);
    });
    await sql
      .raw(
        `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'search')} ON ${tableName} USING GIN(search_vector)`,
      )
      .execute(db);

    await withLockTimeout(db, async (trx) => {
      await sql
        .raw(`
        CREATE OR REPLACE FUNCTION ${tableName}_touch_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `)
        .execute(trx);
      await sql
        .raw(`
        CREATE TRIGGER update_${tableName}_updated_at
          BEFORE UPDATE ON ${tableName}
          FOR EACH ROW
          EXECUTE FUNCTION ${tableName}_touch_updated_at()
      `)
        .execute(trx);
      // Sync pull's record of deleted rows (migration 032).
      await sql.raw(syncTombstoneTrigger(tableName)).execute(trx);
    });

    // Register metadata first so relation inserts can reference valid collection names
    await this.registerMetadata(db, validated);

    await this.refreshSearchTrigger(db, validated.name, undefined, false);

    // Add FK columns and register m2o/reference relations after table + metadata exist
    for (const field of relationFields) {
      const target = String(field.options!.related_collection);
      if (!SAFE_NAME_RE.test(target)) {
        console.warn(
          `[createCollection] Invalid target name '${target}' for field '${field.name}' — skipping`,
        );
        continue;
      }
      if (!(await this.tableExists(db, target))) {
        console.warn(
          `[createCollection] Target '${target}' for field '${field.name}' not found — skipping FK`,
        );
        continue;
      }
      const targetTable = this.getTableName(target);
      const onDelete = String(field.options?.on_delete ?? 'SET NULL').toUpperCase();
      const onUpdate = String(field.options?.on_update ?? 'CASCADE').toUpperCase();

      await this.applyRelationFK(db, tableName, field.name, targetTable, onDelete, onUpdate, false);
      await this.registerRelation(db, {
        name: `${validated.name}_${field.name}`,
        type: 'm2o',
        source_collection: validated.name,
        source_field: field.name,
        target_collection: target,
        target_field: 'id',
        on_delete: onDelete,
        on_update: onUpdate,
      });
    }

    // Create junction tables for m2m fields
    const m2mFields = validated.fields.filter(
      (f) => f.type === 'm2m' && f.options?.related_collection,
    );
    for (const field of m2mFields) {
      const target = String(field.options!.related_collection);
      if (!SAFE_NAME_RE.test(target)) {
        console.warn(`[createCollection] Invalid m2m target '${target}' — skipping`);
        continue;
      }
      if (!(await this.tableExists(db, target))) {
        console.warn(
          `[createCollection] m2m target '${target}' not found — skipping junction table`,
        );
        continue;
      }
      const junctionTable = await this.createJunctionTable(db, validated.name, target);
      await this.registerRelation(db, {
        name: `${validated.name}_${field.name}`,
        type: 'm2m',
        source_collection: validated.name,
        source_field: field.name,
        target_collection: target,
        target_field: 'id',
        junction_table: junctionTable,
      });
    }

    // A collection nobody may touch is not a collection.
    //
    // Authorization denies by default, so a table that has just come into
    // existence is reachable by owners and tenant admins and by nobody else.
    // That is the correct starting point but a useless ending one: an admin
    // creates a collection in the Studio, hands it to their team, and every one
    // of them gets a 403 with nothing on screen explaining why.
    //
    // So the default access the seeded roles used to get from a wildcard is
    // written out here as actual rows — visible in the permissions UI, revocable
    // for this collection alone, and reportable to an auditor, none of which
    // `('tenant_member', '*', '*', 'read')` ever was.
    //
    // This sits next to creation rather than in the boot sequence because the
    // same reasoning applied to RLS and the boot placement was wrong there: a
    // fresh install runs migration 034 while `zvd_collections` is still empty,
    // so if this only ran at startup the core collections would spend their
    // first run of the engine unreachable.
    //
    // Best-effort: a permissions row that fails to write must not roll back a
    // table that already exists. The boot reconcile picks it up.
    try {
      const { materializeDefaultGrants } = await import('../tenancy/index.js');
      await materializeDefaultGrants(db, [validated.name]);
    } catch (err) {
      console.warn(
        `   ⚠  default grants for collection '${validated.name}' failed:`,
        (err as Error).message,
      );
    }
  }

  // ── getTableDependents ───────────────────────────────────────────────────────

  static async getTableDependents(
    db: Database,
    collectionName: string,
  ): Promise<Array<{ table: string; constraint: string; column: string }>> {
    const tableName = this.getTableName(collectionName);
    const result = await sql<{ table: string; constraint: string; column: string }>`
      SELECT
        tc.table_name    AS "table",
        tc.constraint_name AS "constraint",
        kcu.column_name  AS "column"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND ccu.table_name = ${tableName}
        AND tc.table_name != ${tableName}
    `.execute(db);
    return result.rows;
  }

  /**
   * Why `name` cannot be a collection, or null. Collections share the Casbin
   * object column with the objects in `nonCollectionObjects`: under one of those
   * names a collection was read by grants written for something else, and
   * dropping it deleted them (a collection called `data` took every
   * `data:view_all` grant on the instance with it).
   */
  static async reservedName(db: Database, name: string): Promise<string | null> {
    if (!(await nonCollectionObjectsNow(db)).has(name)) return null;
    return `"${name}" is reserved: it names a permission object that is not a collection.`;
  }

  // ── dropCollection ───────────────────────────────────────────────────────────

  /**
   * Drop a collection, its junction tables and every rule keyed by its name.
   *
   * Handed a transaction (the DDL queue), the caller that owns it calls
   * `forgetDroppedCollection` once it has committed; until then — or until the
   * next policy reconcile, if it never does — the grants are gone from the table
   * but not from the live permission model.
   *
   * Its Casbin rules stay when its name is also an object that is not a
   * collection (`reservedName`): they guard that object too.
   */
  static async dropCollection(
    db: Database,
    name: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    // One transaction for the DROPs and the metadata deletes: separately, a failed
    // `zvd_collections` delete left a listed collection with no table, which every
    // retry then refused as "not found". The DDL queue already passes a trx.
    if (!(db as unknown as { isTransaction?: boolean }).isTransaction) {
      await db.transaction().execute((trx) => DDLManager.dropInTransaction(trx, name, opts));
      DDLManager.invalidateCache(name);
      await DDLManager.forgetDroppedCollection(name, db);
      return;
    }
    await DDLManager.dropInTransaction(db, name, opts);
  }

  /**
   * Take a dropped collection's grants out of the live permission model — this
   * instance's and, through the enforcer's watcher, every other's — and drop
   * the cached rules. After the COMMIT: before it, a rollback would leave the
   * collection standing with its grants gone from memory.
   *
   * The rows themselves went in the drop's transaction, so a failure here leaves
   * only memory stale, which the policy reconcile corrects; it is logged, not
   * thrown, since the drop has already happened.
   */
  static async forgetDroppedCollection(name: string, db: Database): Promise<void> {
    try {
      const tenancy = await import('../tenancy/index.js');
      // Filtered, not rule by rule: it reaches the table and the watcher whether
      // or not this instance's model holds the rule, and the receivers apply it
      // to their own models. Not when the drop kept the rules (`reservedName`):
      // it would delete them.
      const kept = await db
        .selectFrom('zvd_permissions')
        .select('id')
        .where('ptype', '=', 'p')
        .where('v2', '=', name)
        .executeTakeFirst();
      if (!kept) await (await tenancy.getEnforcer()).removeFilteredPolicy(2, name);
      await tenancy.invalidateAllPermissionCaches();
      await tenancy.invalidateRlsCache(name);
      await tenancy.invalidateColumnPermCache(name);
      invalidateRulesCache(name);
    } catch (err) {
      console.warn(
        `[ddl] collection '${name}' dropped; its access rules were not cleared from memory:`,
        (err as Error).message,
      );
    }
  }

  private static async dropInTransaction(
    db: Database,
    name: string,
    opts: { force?: boolean },
  ): Promise<void> {
    const tableName = this.getTableName(name);

    if (!(await this.tableExists(db, name))) {
      throw new Error(`Collection '${name}' not found`);
    }

    const deps = await this.getTableDependents(db, name);
    if (deps.length > 0 && !opts.force) {
      const list = deps
        .map((d) => `${d.table}.${d.column} (constraint ${d.constraint})`)
        .join(', ');
      throw new Error(
        `Cannot drop collection '${name}': ${deps.length} foreign key(s) reference it: ${list}. ` +
          `Retry with force=true to DROP ... CASCADE.`,
      );
    }

    // Before anything is dropped: a registry that cannot be read must stop the
    // drop, not let it delete rules it cannot attribute. A collection made under
    // a reserved name before the reservation, or one an extension adopted under
    // a resource it declares, shares its rules with that object; they stay.
    const keepGrants = (await nonCollectionObjectsNow(db)).has(name);

    // Drop m2m junction tables before dropping the main table
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const m2mRelations: any[] = await db
      .selectFrom('zvd_relations')
      .select(['source_collection', 'target_collection', 'junction_table'])
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      .where((eb: any) =>
        eb.or([eb('source_collection', '=', name), eb('target_collection', '=', name)]),
      )
      .where('type', '=', 'm2m')
      .execute();
    // No `.catch(() => [])` here.
    //
    // That turned "I could not find out which junction tables exist" into "there
    // are none", and the code below then dropped the collection and DELETEd every
    // `zvd_relations` row for it — destroying the only record of where those
    // junction tables were. The tables stay on disk, holding rows, referenced by
    // nothing, and no query can now tell you they belong to a collection that is
    // gone. Undoing that means reading table names by hand.
    //
    // A drop that cannot enumerate what it is dropping must not proceed.

    for (const rel of m2mRelations) {
      // Use stored junction_table name if available; fall back to legacy naming
      const junctionName: string =
        rel.junction_table || `zvd_jnc_${rel.source_collection}_${rel.target_collection}`;
      if (/^zvd_[a-z][a-z0-9_]*$/.test(junctionName)) {
        await withLockTimeout(db, async (trx) => {
          await sql.raw(`DROP TABLE IF EXISTS "${junctionName}" CASCADE`).execute(trx);
        }).catch((err: Error) => {
          // Rethrown, not warned past. Continuing here left the junction table
          // in place and then deleted the relation rows that named it, which is
          // the same orphan by a different route.
          throw new Error(
            `Cannot drop collection "${name}": its junction table ${junctionName} could not be ` +
              `dropped (${err.message}). Nothing has been deleted.`,
          );
        });
      }
    }

    await withLockTimeout(db, async (trx) => {
      await sql.raw(`DROP TABLE IF EXISTS ${tableName} CASCADE`).execute(trx);
    });

    // Clean up relation metadata for both sides — the FK constraint is
    // already gone (DROP TABLE CASCADE handled it), but the zvd_relations
    // rows persist and would re-emerge as ghost relations in the schema view.
    await db
      .deleteFrom('zvd_relations')
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      .where((eb: any) =>
        eb.or([eb('source_collection', '=', name), eb('target_collection', '=', name)]),
      )
      .execute();
    // Also no `.catch`. Warning past this leaves `zvd_relations` rows pointing at
    // a collection that no longer exists, which the schema view renders as ghost
    // relations — and the row that would have told an operator what happened is
    // the row that failed to be written.

    await db.deleteFrom('zvd_collections').where('name', '=', name).execute();

    // Everything else keyed by the name goes with it, in the same transaction.
    // Left behind, a collection created again under this name inherited it all:
    // a grant made in any tenant's domain on the old collection read the new one,
    // and the old row rules, hidden columns and validation applied to it.
    if (!keepGrants) {
      await db
        .deleteFrom('zvd_permissions')
        .where('ptype', '=', 'p')
        .where('v2', '=', name)
        .execute();
    }
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${name}`.execute(db);
    await db.deleteFrom('zvd_column_permissions').where('collection_name', '=', name).execute();
    await db.deleteFrom('zv_validation_rules').where('collection', '=', name).execute();

    DDLManager.invalidateCache(name);
  }

  /**
   * Every registered relation (`zvd_relations`), optionally only those touching
   * one collection. The read path extensions get in place of raw SQL on the
   * engine's metadata table, which `ctx.db` refuses.
   */
  static async getRelations(db: Database, collection?: string) {
    let q = db
      .selectFrom('zvd_relations')
      .select([
        'id',
        'name',
        'type',
        'source_collection',
        'source_field',
        'target_collection',
        'target_field',
        'junction_table',
      ])
      .orderBy('name');
    if (collection) {
      q = q.where((eb) =>
        eb.or([eb('source_collection', '=', collection), eb('target_collection', '=', collection)]),
      );
    }
    return q.execute();
  }

  // ── getCollections / getCollection ───────────────────────────────────────────

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  static async getCollections(db: Database): Promise<any[]> {
    const now = Date.now();
    if (_collectionsListCache && now - _collectionsListCache.ts < METADATA_CACHE_TTL_MS) {
      return _collectionsListCache.data;
    }
    const genBefore = _cacheGen;
    const rows = await db
      .selectFrom('zvd_collections')
      .selectAll()
      .orderBy('sort')
      .orderBy('name')
      .execute();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const normalized = (rows as any[]).map((row) => ({
      ...row,
      fields: typeof row.fields === 'string' ? JSON.parse(row.fields) : (row.fields ?? []),
    }));
    if (_cacheGen === genBefore) {
      _collectionsListCache = { data: normalized, ts: now };
    }
    return normalized;
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  static async getCollection(db: Database, name: string): Promise<any | null> {
    const now = Date.now();
    const cached = collectionCache.get(name);
    if (cached && now - cached.ts < METADATA_CACHE_TTL_MS) return cached.data;
    const genBefore = _cacheGen;
    const row = await db
      .selectFrom('zvd_collections')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();
    const result = row
      ? {
          ...row,
          fields:
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
            typeof (row as any).fields === 'string'
              ? // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
                JSON.parse((row as any).fields)
              : // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
                ((row as any).fields ?? []),
        }
      : null;
    if (_cacheGen === genBefore) {
      collectionCache.set(name, { data: result, ts: now });
    }
    return result;
  }

  static async updateCollectionMetadata(
    db: Database,
    name: string,
    updates: Partial<CollectionDefinition>,
  ): Promise<void> {
    await db
      .updateTable('zvd_collections')
      .set({
        ...(updates.displayName ? { display_name: updates.displayName } : {}),
        ...(updates.icon ? { icon: updates.icon } : {}),
        ...(updates.description !== undefined ? { description: updates.description } : {}),
        ...(updates.fields ? { fields: toJsonb(updates.fields) } : {}),
        updated_at: new Date(),
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      } as any)
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      .where('name' as any, '=', name)
      .execute();
    // Every path that adds, drops or renames a field records it here.
    if (updates.fields) await this.refreshSearchTrigger(db, name, updates.fields);
    DDLManager.invalidateCache(name);
  }

  /**
   * Point `<table>_search_trigger()` at the collection's current text fields.
   * Returns whether anything changed; a settled table costs two catalog reads.
   *
   * Adds `search_text` and its trigram index for a collection that gains its
   * first text field — but only on the pool, since the index is built
   * CONCURRENTLY. Inside a transaction fields are only ever being removed or
   * renamed, which needs neither.
   */
  static async refreshSearchTrigger(
    db: Database,
    collectionName: string,
    fields?: { name: string; type: string }[],
    /** False from `createCollection`, for the table it just made; see the note there. */
    concurrently = true,
  ): Promise<boolean> {
    if (!SAFE_NAME_RE.test(collectionName)) return false;
    const tableName = this.getTableName(collectionName);
    const meta = await db
      .selectFrom('zvd_collections')
      .select(['is_managed', 'fields'])
      .where('name', '=', collectionName)
      .executeTakeFirst();
    // A BYOD table's triggers are its owner's.
    if (!meta || meta.is_managed === false) return false;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const all: any[] =
      fields ?? (typeof meta.fields === 'string' ? JSON.parse(meta.fields) : (meta.fields ?? []));
    const names = all
      .filter((f) => SEARCH_FIELD_TYPES.has(f?.type) && SAFE_NAME_RE.test(f?.name ?? ''))
      .map((f) => f.name as string);

    const cols = await sql<{ attname: string }>`
      SELECT attname::text AS attname FROM pg_attribute
      WHERE attrelid = to_regclass(${tableName}) AND NOT attisdropped
        AND attname IN ('search_vector', 'search_text')
    `.execute(db);
    const has = new Set(cols.rows.map((c) => c.attname));
    const inTransaction = (db as unknown as { isTransaction?: boolean }).isTransaction === true;

    if (names.length > 0 && !has.has('search_text') && !inTransaction) {
      await withLockTimeout(db, async (trx) => {
        await sql
          .raw(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS search_text text`)
          .execute(trx);
      });
      await buildIndex(
        db,
        `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'trgm')} ON ${tableName} USING GIN(search_text gin_trgm_ops)`,
        concurrently,
      );
      await db
        .updateTable('zvd_collections')
        .set({ has_trgm: true })
        .where('name', '=', collectionName)
        .execute();
      has.add('search_text');
    }

    const current = await sql<{ src: string | null; trg: boolean }>`
      SELECT (SELECT prosrc FROM pg_proc WHERE proname = ${`${tableName}_search_trigger`}
                AND pronamespace = current_schema()::regnamespace) AS src,
             EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = ${`${tableName}_search_update`}
                AND tgrelid = to_regclass(${tableName})) AS trg
    `.execute(db);
    const { src, trg } = current.rows[0] ?? { src: null, trg: false };

    if (names.length === 0 || !(has.has('search_vector') || has.has('search_text'))) {
      if (!trg) return false;
      await withLockTimeout(db, async (trx) => {
        await sql
          .raw(`DROP TRIGGER IF EXISTS ${tableName}_search_update ON ${tableName}`)
          .execute(trx);
      });
      return true;
    }

    const body = searchTriggerBody(names, has.has('search_vector'), has.has('search_text'));
    if (trg && src === body) return false;
    await withLockTimeout(db, async (trx) => {
      await sql
        .raw(
          `CREATE OR REPLACE FUNCTION ${tableName}_search_trigger() RETURNS trigger AS $$${body}$$ LANGUAGE plpgsql`,
        )
        .execute(trx);
      await sql
        .raw(`DROP TRIGGER IF EXISTS ${tableName}_search_update ON ${tableName}`)
        .execute(trx);
      await sql
        .raw(
          `CREATE TRIGGER ${tableName}_search_update BEFORE INSERT OR UPDATE ON ${tableName} ` +
            `FOR EACH ROW EXECUTE FUNCTION ${tableName}_search_trigger()`,
        )
        .execute(trx);
    });
    return true;
  }

  /**
   * `refreshSearchTrigger` over every managed collection, at boot. Collections
   * created before it carry the `NEW."field"` form, and one that already lost a
   * text field cannot be written until this runs.
   */
  static async reconcileSearchTriggers(db: Database): Promise<number> {
    const rows = await db
      .selectFrom('zvd_collections')
      .select('name')
      .where((eb) => eb.or([eb('is_managed', 'is', null), eb('is_managed', '=', true)]))
      .execute();
    let changed = 0;
    for (const { name } of rows) {
      if (await this.refreshSearchTrigger(db, name)) changed++;
    }
    return changed;
  }

  /**
   * Gives a column added to an existing table the key `createCollection` would
   * have given it — `UNIQUE (tenant_id, <col>)` for a `unique` field, nothing
   * otherwise. Every road that adds a column calls this right after it.
   *
   * Idempotent by DEFINITION, not by name: the DDL queue retries a failed job,
   * and the column's `ADD … IF NOT EXISTS` is a no-op the second time while a
   * bare `ADD UNIQUE` would stack a second key. A name check is no good either —
   * a renamed column keeps the constraint named after its old name.
   */
  static async addUniqueKey(
    db: Database,
    tableName: string,
    field: Pick<FieldConfig, 'name' | 'type' | 'unique'>,
  ): Promise<void> {
    const key = fieldTypeRegistry.getUniqueKeyDDL(field);
    if (!key) return;
    const existing = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_constraint k
      WHERE k.conrelid = to_regclass(quote_ident(${tableName})) AND k.contype IN ('u', 'p')
        AND k.conkey = ARRAY(
          SELECT a.attnum FROM unnest(ARRAY['tenant_id', ${field.name}]) WITH ORDINALITY AS c(name, i)
          JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attname = c.name ORDER BY c.i
        )::int2[]
    `.execute(db);
    if ((existing.rows[0]?.n ?? 0) > 0) return;
    await withLockTimeout(db, async (trx) => {
      await sql`ALTER TABLE ${sql.id(tableName)} ADD ${sql.raw(key)}`.execute(trx);
    });
  }

  /**
   * Brings an existing column's default, unique key and indexes to what
   * `field` says, as `createCollection` and `addField` would have built them.
   * Only the keys named in `keys` are touched; metadata is the caller's.
   *
   * The builds run CONCURRENTLY (outside any transaction), so the table keeps
   * taking writes while an index is built over existing rows. A unique key is
   * built as an index first, then attached as the constraint under a lock
   * timeout — the way `unique-key-reconcile.ts` widens old keys. Rows that
   * already repeat a value within a tenant fail the build with 23505, and the
   * INVALID index it leaves behind is dropped before the error goes up.
   */
  static async setFieldKeys(
    db: Database,
    collectionName: string,
    field: FieldConfig,
    keys: ReadonlyArray<string>,
  ): Promise<void> {
    const tableName = this.getTableName(collectionName);
    const typeDef = fieldTypeRegistry.get(field.type);
    if (!typeDef || typeDef.db.virtual) throw new Error(`"${field.name}" has no column`);

    if (keys.includes('defaultValue')) {
      const value = field.defaultValue ?? typeDef.db.defaultValue;
      await withLockTimeout(db, async (trx) => {
        await sql
          .raw(
            value === undefined || value === null
              ? `ALTER TABLE "${tableName}" ALTER COLUMN "${field.name}" DROP DEFAULT`
              : `ALTER TABLE "${tableName}" ALTER COLUMN "${field.name}" SET DEFAULT ${renderSqlDefault(value)}`,
          )
          .execute(trx);
      });
    }

    if (keys.includes('unique')) {
      const found = await findTenantUniqueIndex(db, tableName, field.name);
      if (field.unique && !found?.constraint) {
        let name = found?.index;
        if (!name) {
          // The usual name may belong to the key of a column renamed away.
          const base = `${tableName}_tenant_id_${field.name}_key`;
          for (let n = 0; !name; n++) {
            const candidate = pgIdentifier(n ? `${base}_${n}` : base);
            const taken = await sql`SELECT to_regclass(quote_ident(${candidate})) AS r`.execute(db);
            if ((taken.rows[0] as { r: unknown }).r === null) name = candidate;
          }
        }
        // Any failure — a duplicate in the build, a lock timeout in the
        // attach — drops the index: left unattached, it would go on refusing
        // duplicates while the field says it is not unique, out of reach of
        // `unique: false`.
        try {
          if (!found) await buildTenantUniqueIndex(db, tableName, field.name, name);
          await withLockTimeout(db, async (trx) => {
            await sql`ALTER TABLE ${sql.id(tableName)} ADD CONSTRAINT ${sql.id(name)} UNIQUE USING INDEX ${sql.id(name)}`.execute(
              trx,
            );
          });
        } catch (err) {
          await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id(name)}`.execute(db);
          throw err;
        }
      } else if (!field.unique && found) {
        if (found.constraint) {
          const constraint = found.constraint;
          await withLockTimeout(db, async (trx) => {
            await sql`ALTER TABLE ${sql.id(tableName)} DROP CONSTRAINT ${sql.id(constraint)}`.execute(
              trx,
            );
          });
        } else {
          await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id(found.index)}`.execute(db);
        }
      }
    }

    if (keys.includes('indexed')) {
      if (field.indexed) {
        const plain = fieldTypeRegistry.getIndexDDL(tableName, field);
        if (plain) await buildIndex(db, plain);
        const tenant = fieldTypeRegistry.getTenantIndexDDL(tableName, field);
        if (tenant) await buildIndex(db, tenant);
      } else {
        await sql
          .raw(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName(tableName, `tenant_${field.name}`)}`)
          .execute(db);
        // A type with its own index method (GIN, GiST…) gets that index
        // whatever `indexed` says; only the btree one is the flag's.
        if (!typeDef.db.indexType) {
          await sql
            .raw(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName(tableName, field.name)}`)
            .execute(db);
        }
      }
    }
    this.invalidateCache(collectionName);
  }

  // ── addField ─────────────────────────────────────────────────────────────────

  static async addField(
    db: Database,
    collectionName: string,
    field: z.infer<typeof FieldSchema>,
  ): Promise<void> {
    const validated = FieldSchema.parse(field);
    // Here, not in each route: the schema-branch merge called this layer's
    // building blocks with a name no route had checked.
    if (SYSTEM_COLUMNS.has(validated.name)) {
      throw new Error(`"${validated.name}" is a system column`);
    }
    if (!fieldTypeRegistry.has(validated.type)) {
      throw new Error(`Unknown field type: "${validated.type}"`);
    }
    const tableName = this.getTableName(collectionName);
    if (!(await this.tableExists(db, collectionName))) {
      throw new Error(`Collection '${collectionName}' not found`);
    }
    const colDDL = fieldTypeRegistry.getColumnDDL(validated as FieldConfig);
    if (colDDL) {
      await withLockTimeout(db, async (trx) => {
        await sql`ALTER TABLE ${sql.id(tableName)} ADD COLUMN IF NOT EXISTS ${sql.raw(colDDL)}`.execute(
          trx,
        );
        await this.addUniqueKey(trx, tableName, validated as FieldConfig);
      });
    }
    const indexDDL = fieldTypeRegistry.getIndexDDL(tableName, validated as FieldConfig);
    if (indexDDL) await buildIndex(db, indexDDL);
    // A field added to an existing collection gets the same pair as one created
    // with it. Both sites, because the repository has been bitten by a fix that
    // landed on only one of two paths before.
    const tenantIndexDDL = fieldTypeRegistry.getTenantIndexDDL(tableName, validated as FieldConfig);
    if (tenantIndexDDL) await buildIndex(db, tenantIndexDDL);
    const existing = await this.getCollection(db, collectionName);
    if (existing) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const fields: any[] =
        typeof existing.fields === 'string' ? JSON.parse(existing.fields) : (existing.fields ?? []);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      if (!fields.some((f: any) => f.name === validated.name)) {
        fields.push(validated);
        await this.updateCollectionMetadata(db, collectionName, { fields });
      }
    }
    this.invalidateCache(collectionName);
  }

  /**
   * Deletes the rules naming a field that is being dropped and rebuilds the
   * row-rule policy without them — in the drop's transaction, before the DROP
   * COLUMN: Postgres refuses to drop a column the policy names. Left behind,
   * the rules reached a field later added under the same name. Caches go after
   * the commit (`forgetFieldRules`).
   */
  static async dropFieldRules(db: Database, collection: string, field: string): Promise<void> {
    let rowRules = 0;
    for (const [table, col, fieldCol] of FIELD_RULE_TABLES) {
      const gone = await sql`DELETE FROM ${sql.id(table)}
                              WHERE ${sql.id(col)} = ${collection} AND ${sql.id(fieldCol)} = ${field}
                              RETURNING 1`.execute(db);
      if (table === 'zvd_rls_policies') rowRules = gone.rows.length;
    }
    if (rowRules > 0) {
      const { applyRowRulePolicy } = await import('../tenancy/index.js');
      await applyRowRulePolicy(db, collection);
    }
  }

  /** After the commit that changed a collection's field rules: a read before it would re-cache the old ones. */
  static async forgetFieldRules(collection: string): Promise<void> {
    const tenancy = await import('../tenancy/index.js');
    await tenancy.invalidateColumnPermCache(collection);
    await tenancy.invalidateRlsCache(collection);
    invalidateRulesCache(collection);
  }

  // ── removeField ──────────────────────────────────────────────────────────────

  static async removeField(db: Database, collectionName: string, fieldName: string): Promise<void> {
    if (!/^[a-z][a-z0-9_]*$/.test(fieldName)) {
      throw new Error(`Invalid field name: "${fieldName}".`);
    }
    if (SYSTEM_COLUMNS.has(fieldName)) {
      throw new Error(`"${fieldName}" is a system column`);
    }
    const tableName = this.getTableName(collectionName);
    if (!(await this.tableExists(db, collectionName))) {
      throw new Error(`Collection '${collectionName}' not found`);
    }
    await withLockTimeout(db, async (trx) => {
      await DDLManager.dropFieldRules(trx, collectionName, fieldName);
      await sql`ALTER TABLE ${sql.id(tableName)} DROP COLUMN IF EXISTS ${sql.id(fieldName)}`.execute(
        trx,
      );
    });
    const existing = await this.getCollection(db, collectionName);
    if (existing) {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const fields: any[] =
        typeof existing.fields === 'string' ? JSON.parse(existing.fields) : (existing.fields ?? []);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const updated = fields.filter((f: any) => f.name !== fieldName);
      await this.updateCollectionMetadata(db, collectionName, { fields: updated });
    }
    this.invalidateCache(collectionName);
    // Handed a transaction (the DDL queue), its owner does this after the commit.
    if (!(db as unknown as { isTransaction?: boolean }).isTransaction) {
      await DDLManager.forgetFieldRules(collectionName);
    }
  }

  // ── previewCollection ────────────────────────────────────────────────────────

  /** Returns the exact SQL that `createCollection` would run, including
   *  FK constraints for relation fields — used by the Studio "Preview" dialog. */
  static async previewCollection(
    schema: z.infer<typeof CollectionSchema>,
  ): Promise<{ sql: string[] }> {
    const SAFE_NAME = /^[a-z][a-z0-9_]*$/;
    if (!SAFE_NAME.test(schema.name)) throw new Error(`Invalid collection name: "${schema.name}"`);
    const tableName = `zvd_${schema.name}`;
    const statements: string[] = [];

    const userCols = schema.fields
      .map((f) => {
        // Relation fields: show FK column in preview
        if (RELATION_FK_TYPES.has(f.type) && f.options?.related_collection) {
          const targetTable = `zvd_${f.options.related_collection}`;
          const onDelete = String(f.options?.on_delete ?? 'SET NULL').toUpperCase();
          return `  "${f.name}" UUID REFERENCES "${targetTable}"(id) ON DELETE ${onDelete}`;
        }
        // The same column DDL createCollection writes, per-field defaults included.
        const colDDL = fieldTypeRegistry.getColumnDDL(f as FieldConfig);
        return colDDL ? `  ${colDDL}` : null;
      })
      .filter((s): s is string => s !== null);
    // …and the same per-tenant unique keys, after the columns as there.
    const uniqueKeys = schema.fields
      .filter((f) => !RELATION_FK_TYPES.has(f.type) || !f.options?.related_collection)
      .map((f) => fieldTypeRegistry.getUniqueKeyDDL(f as FieldConfig))
      .filter((s): s is string => s !== null)
      .map((k) => `  ${k}`);

    statements.push(
      `CREATE TABLE IF NOT EXISTS ${tableName} (\n${[...SYSTEM_COLUMN_DDL.map((c) => `  ${c}`), ...userCols, ...uniqueKeys].join(',\n')}\n);`,
    );

    statements.push(
      `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'created_at')} ON ${tableName}(created_at DESC);`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'tenant_id')} ON ${tableName}(tenant_id);`,
      // The composite every list endpoint needs: `ORDER BY created_at DESC` for
      // one tenant. Without it the planner walks `created_at` and throws away
      // the other tenants' rows — 6 408 discarded to return 25, on a table with
      // 63 tenants. See the note in tenant-manager.applyTenantRLS.
      `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'tenant_created')} ON ${tableName}(tenant_id, created_at DESC);`,
      // The keyset the sync pull walks, for the same reason (see applyTenantRLS).
      `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'tenant_updated')} ON ${tableName}(tenant_id, updated_at, (id::text COLLATE "C"));`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'status')} ON ${tableName}(status);`,
    );

    for (const field of schema.fields) {
      if (RELATION_FK_TYPES.has(field.type)) {
        statements.push(
          `CREATE INDEX IF NOT EXISTS ${indexName(tableName, field.name)} ON ${tableName}("${field.name}");`,
        );
        continue;
      }
      for (const ddl of [
        fieldTypeRegistry.getIndexDDL(tableName, field as FieldConfig),
        fieldTypeRegistry.getTenantIndexDDL(tableName, field as FieldConfig),
      ]) {
        if (ddl) statements.push(`${ddl};`);
      }
    }

    statements.push(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS search_vector tsvector;`);
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${indexName(tableName, 'search')} ON ${tableName} USING GIN(search_vector);`,
    );
    statements.push(`-- Per-table updated_at trigger`);
    statements.push(
      `CREATE OR REPLACE FUNCTION ${tableName}_touch_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;`,
    );
    statements.push(
      `CREATE TRIGGER update_${tableName}_updated_at BEFORE UPDATE ON ${tableName} FOR EACH ROW EXECUTE FUNCTION ${tableName}_touch_updated_at();`,
    );
    statements.push(`${syncTombstoneTrigger(tableName)};`);

    // Show relation registrations in preview
    const relFields = schema.fields.filter(
      (f) => RELATION_FK_TYPES.has(f.type) && f.options?.related_collection,
    );
    if (relFields.length > 0) {
      statements.push(`-- Relation metadata`);
      for (const f of relFields) {
        statements.push(
          `INSERT INTO zvd_relations (name, type, source_collection, source_field, target_collection, target_field) ` +
            `VALUES ('${schema.name}_${f.name}', 'm2o', '${schema.name}', '${f.name}', '${f.options!.related_collection}', 'id');`,
        );
      }
    }

    return { sql: statements };
  }

  // ── introspectTable ──────────────────────────────────────────────────────────

  private static pgTypeToFieldType(udtName: string, dataType: string): string {
    const udt = (udtName || '').toLowerCase();
    const dt = (dataType || '').toLowerCase();
    if (udt === 'uuid') return 'uuid';
    if (udt === 'bool') return 'boolean';
    if (udt === 'int2' || udt === 'int4' || udt === 'int8') return 'integer';
    if (udt === 'numeric' || udt === 'float4' || udt === 'float8') return 'number';
    if (udt === 'date') return 'date';
    if (udt === 'timestamp' || udt === 'timestamptz') return 'datetime';
    if (udt === 'jsonb' || udt === 'json') return 'json';
    if (dt === 'array' || udt.startsWith('_')) return 'tags';
    if (udt === 'tsvector') return 'text';
    return 'text';
  }

  /**
   * Reads field metadata from information_schema, including FK references
   * via the constraint tables — that's how introspected fields get
   * `options.related_collection` populated for BYOD / sync-schema flows.
   */
  /**
   * Every physical column of a collection's table, system columns included, in
   * table order — `[]` when the table is not there.
   *
   * `introspectTable` answers the USER fields and skips `id`, `status` and the
   * rest; a caller that checks a name against the table (a page filtering on
   * `status`, a record addressed by `id`) needs all of them. Extensions read
   * this through `ctx.DDLManager`, because `ctx.db` refuses `information_schema`
   * to them (#858) — the engine runs this on its own view of the catalog.
   */
  static async columnNames(db: Database, collectionName: string): Promise<string[]> {
    const tableName = this.getTableName(collectionName);
    const cols = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
      ORDER BY ordinal_position
    `.execute(db);
    return cols.rows.map((r) => r.column_name);
  }

  static async introspectTable(db: Database, collectionName: string): Promise<FieldConfig[]> {
    const tableName = this.getTableName(collectionName);
    const SYSTEM_COLS = SYSTEM_COLUMNS;

    // Fetch column info
    const cols = await sql<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }>`
      SELECT column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
      ORDER BY ordinal_position
    `.execute(db);

    const fks = await sql<{
      column_name: string;
      foreign_table_name: string;
    }>`
      SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ${tableName}
        AND ccu.table_name != 'user'
    `.execute(db);

    // Map column_name → related zvd_ collection name (strip zvd_ prefix)
    const fkMap = new Map<string, string>();
    for (const fk of fks.rows) {
      if (fk.foreign_table_name.startsWith('zvd_')) {
        fkMap.set(fk.column_name, fk.foreign_table_name.slice(4)); // strip 'zvd_'
      }
    }

    return cols.rows
      .filter((r) => !SYSTEM_COLS.has(r.column_name))
      .map((r) => {
        const relatedCollection = fkMap.get(r.column_name);
        if (relatedCollection) {
          return {
            name: r.column_name,
            type: 'm2o',
            required: r.is_nullable === 'NO',
            options: { related_collection: relatedCollection },
          } as FieldConfig;
        }
        return {
          name: r.column_name,
          type: this.pgTypeToFieldType(r.udt_name, r.data_type),
          required: r.is_nullable === 'NO',
        } as FieldConfig;
      });
  }

  static async syncFieldsFromDB(db: Database, collectionName: string): Promise<number> {
    const meta = await this.getCollection(db, collectionName);
    if (!meta) return 0;
    const existing = typeof meta.fields === 'string' ? JSON.parse(meta.fields) : meta.fields;
    if (Array.isArray(existing) && existing.length > 0) return 0;
    if (!(await this.tableExists(db, collectionName))) return 0;
    const fields = await this.introspectTable(db, collectionName);
    if (fields.length === 0) return 0;
    await db
      .updateTable('zvd_collections')
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      .set({ fields: toJsonb(fields), updated_at: new Date() } as any)
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      .where('name' as any, '=', collectionName)
      .execute();
    this.invalidateCache(collectionName);
    return fields.length;
  }

  static async registerMetadata(db: Database, definition: CollectionDefinition): Promise<void> {
    await db
      .insertInto('zvd_collections')
      .values({
        name: definition.name,
        display_name: definition.displayName || definition.name,
        icon: definition.icon || 'Table',
        route_group: definition.routeGroup || 'private',
        is_permissioned: definition.isPermissioned ?? true,
        is_managed: definition.isManaged ?? true,
        is_system: definition.isSystem ?? false,
        schema_locked: definition.schemaLocked ?? false,
        sort: definition.sort ?? 99,
        singular_name: definition.singularName || definition.name,
        description: definition.description || null,
        fields: toJsonb(definition.fields),
      })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet({
          display_name: definition.displayName || definition.name,
          fields: toJsonb(definition.fields),
          updated_at: new Date(),
        }),
      )
      .execute();
    DDLManager.invalidateCache(definition.name);
  }
}
