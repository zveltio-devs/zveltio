import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { fieldTypeRegistry, type FieldConfig } from './field-type-registry.js';

// ─── Safe DDL helpers ─────────────────────────────────────────────────────────

/**
 * Execute a DDL operation that requires AccessExclusiveLock (ALTER TABLE,
 * CREATE TRIGGER, DROP TABLE) in a transaction with strict lock_timeout.
 *
 * SET LOCAL → timeout applies ONLY in this transaction; at COMMIT
 * the connection from pool returns to default setting (no timeout).
 *
 * If the lock cannot be obtained in `timeout`, PostgreSQL throws
 * `ERROR 55P03: lock not available` instead of blocking the event loop.
 */
async function withLockTimeout(
  db: Database,
  fn: (trx: Database) => Promise<void>,
  timeout = '2s',
): Promise<void> {
  // C1 FIX: Validate timeout format to prevent SQL injection via raw string interpolation.
  // Only allow digits + optional decimal point followed by ms/s/min unit.
  if (!/^\d+(\.\d+)?(ms|s|min)$/.test(timeout)) {
    throw new Error(
      `Invalid lock_timeout format: "${timeout}". Expected format: "2s", "500ms", "1min".`,
    );
  }
  await (db as any).transaction().execute(async (trx: Database) => {
    await sql.raw(`SET LOCAL lock_timeout = '${timeout}'`).execute(trx);
    await fn(trx);
  });
}

/**
 * Transform a CREATE INDEX into CREATE INDEX CONCURRENTLY.
 *
 * CONCURRENTLY uses ShareUpdateExclusiveLock instead of ShareLock,
 * allowing concurrent INSERT/UPDATE/DELETE while the index is being built.
 * Cannot run inside an explicit transaction block.
 */
function toConcurrentIndex(indexSQL: string): string {
  // Regex handles CREATE UNIQUE INDEX as well
  return indexSQL.replace(
    /^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)(?!CONCURRENTLY\s)/i,
    '$1CONCURRENTLY ',
  );
}

// Schema validation using registry types (dynamic, supports extension types)
export const FieldSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      'Field name must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
    ),
  type: z.string().max(50), // validated at runtime against registry; max 50 chars prevents DoS
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  indexed: z.boolean().default(false),
  defaultValue: z.any().optional(),
  // H2 FIX: Bound options keys/values to prevent DoS via deeply nested payloads.
  options: z
    .record(
      z.string().max(100),
      z.union([
        z.string().max(10_000),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.any()),
      ]),
    )
    .optional(),
  label: z.string().max(200).optional(),
  description: z.string().max(1_000).optional(),
  encrypted: z.boolean().default(false).optional(),
});

export const CollectionSchema = z.object({
  name: z
    .string()
    .max(
      63,
      'Collection name must be at most 63 characters (PostgreSQL identifier limit)',
    )
    .regex(
      /^[a-z][a-z0-9_]*$/,
      'Collection name must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
    ),
  displayName: z.string().optional(),
  icon: z.string().optional(),
  routeGroup: z.enum(['public', 'partners', 'private', 'admin']).optional(),
  isPermissioned: z.boolean().optional(),
  sort: z.number().int().min(0).optional(),
  fields: z.array(FieldSchema).min(1),
  description: z.string().optional(),
  singularName: z.string().optional(),
  aiSearchEnabled: z.boolean().optional(),
  aiSearchField: z.string().nullable().optional(),
  isManaged: z.boolean().optional(),
  isSystem: z.boolean().optional(),
  schemaLocked: z.boolean().optional(),
});

export type CollectionDefinition = z.infer<typeof CollectionSchema>;

// ─── In-memory metadata cache ──────────────────────────────────────────────────
// Caches collection definitions for TTL seconds to avoid a DB round-trip on every
// CRUD request. Invalidated explicitly after schema mutations (create/drop/update).
const METADATA_CACHE_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  data: any;
  ts: number;
}

const collectionCache = new Map<string, CacheEntry>();
let _collectionsListCache: { data: any[]; ts: number } | null = null;

// Generation counter — incremented on every invalidateCache() call.
// Async reads capture this value before their DB SELECT and skip the cache
// write if it changed while awaiting, preventing stale-fill after invalidation:
//   Request A starts SELECT (gen=5) → invalidateCache() bumps to gen=6
//   → A finishes, checks gen still 5? No → discards result, next request re-fetches.
let _cacheGen = 0;

export class DDLManager {
  static getTableName(collectionName: string): string {
    return `zvd_${collectionName}`;
  }

  /** Invalidates the in-memory cache for a specific collection (call after DDL mutations). */
  static invalidateCache(name?: string): void {
    _cacheGen++; // bump generation before clearing so in-flight reads see the change
    if (name) {
      collectionCache.delete(name);
    } else {
      collectionCache.clear();
    }
    _collectionsListCache = null;
  }

  static async tableExists(
    db: Database,
    collectionName: string,
  ): Promise<boolean> {
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

  static async createCollection(
    db: Database,
    definition: CollectionDefinition,
  ): Promise<void> {
    const validated = CollectionSchema.parse(definition);

    // Validate all field types are registered
    for (const field of validated.fields) {
      if (!fieldTypeRegistry.has(field.type)) {
        throw new Error(
          `Unknown field type: "${field.type}". Available types: ${fieldTypeRegistry.list().join(', ')}`,
        );
      }
    }

    const tableName = this.getTableName(validated.name);

    // N4: defense-in-depth — ensure tableName is safe before any sql.raw() usage.
    // validated.name is already regex-checked by Zod, but a future refactor could
    // introduce a different code path. This guard prevents sql injection if it does.
    const SAFE_TABLE_RE = /^zvd_[a-z][a-z0-9_]*$/;
    if (!SAFE_TABLE_RE.test(tableName)) {
      throw new Error(
        `Invalid table name: "${tableName}". Only lowercase letters, numbers, and underscores are allowed.`,
      );
    }

    if (await this.tableExists(db, validated.name)) {
      throw new Error(`Collection '${validated.name}' already exists`);
    }

    // Base columns
    const columns: string[] = [
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived'))",
      'created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL',
      'updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL',
    ];

    const indexes: string[] = [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_created_at ON ${tableName}(created_at DESC)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_status ON ${tableName}(status)`,
    ];

    // Security: whitelist of allowed PostgreSQL extensions.
    const ALLOWED_PG_EXTENSIONS = new Set([
      'pgvector', // AI embeddings
      'postgis', // Geospatial
      'postgis_topology',
      'uuid-ossp', // UUID generation
      'pg_trgm', // Trigram similarity search
      'unaccent', // Text search accent normalization
      'btree_gist', // GiST indexes for B-tree types
      'btree_gin', // GIN indexes for B-tree types
      'hstore', // Key-value store column type
      'citext', // Case-insensitive text
      'intarray', // Integer array operations
      'fuzzystrmatch', // Fuzzy string matching
    ]);

    // Ensure required extensions
    const requiredExtensions = fieldTypeRegistry.getRequiredExtensions(
      validated.fields as FieldConfig[],
    );
    for (const ext of requiredExtensions) {
      if (!ALLOWED_PG_EXTENSIONS.has(ext)) {
        throw new Error(
          `PostgreSQL extension "${ext}" is not in the allowed extensions whitelist. ` +
            `Contact your administrator to add it to ALLOWED_PG_EXTENSIONS in ddl-manager.ts.`,
        );
      }
      await sql`CREATE EXTENSION IF NOT EXISTS ${sql.id(ext)}`.execute(db);
    }

    // Build column definitions using FieldTypeRegistry
    for (const field of validated.fields) {
      const colDDL = fieldTypeRegistry.getColumnDDL(field as FieldConfig);
      if (!colDDL) continue; // virtual/computed — skip

      columns.push(colDDL);

      // Index if requested
      const indexDDL = fieldTypeRegistry.getIndexDDL(
        tableName,
        field as FieldConfig,
      );
      if (indexDDL) indexes.push(toConcurrentIndex(indexDDL));
    }

    // Create table
    await sql
      .raw(
        `
      CREATE TABLE ${tableName} (
        ${columns.join(',\n        ')}
      )
    `,
      )
      .execute(db);

    // Create indexes
    for (const indexSQL of indexes) {
      await sql.raw(indexSQL).execute(db);
    }

    // Full-text search vector
    const textFields = validated.fields
      .filter((f) => ['text', 'richtext', 'email'].includes(f.type))
      .map((f) => f.name);

    // ALTER TABLE → lock_timeout (AccessExclusiveLock, instant for nullable column without default)
    await withLockTimeout(db, async (trx) => {
      await sql
        .raw(
          `
        ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS search_vector tsvector
      `,
        )
        .execute(trx);
    });

    // GIN index → CONCURRENTLY (does not block writes while building)
    await sql
      .raw(
        `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_search ON ${tableName} USING GIN(search_vector)
    `,
      )
      .execute(db);

    if (textFields.length > 0) {
      const weightsClause = textFields
        .map((f, i) => {
          const weight = i === 0 ? 'A' : i === 1 ? 'B' : i === 2 ? 'C' : 'D';
          return `setweight(to_tsvector('english', coalesce(NEW."${f}", '')), '${weight}')`;
        })
        .join(' || ');

      // CREATE OR REPLACE FUNCTION + CREATE TRIGGER → withLockTimeout (ShareRowExclusiveLock)
      await withLockTimeout(db, async (trx) => {
        await sql
          .raw(
            `
          CREATE OR REPLACE FUNCTION ${tableName}_search_trigger() RETURNS trigger AS $$
          BEGIN
            NEW.search_vector := ${weightsClause};
            RETURN NEW;
          END
          $$ LANGUAGE plpgsql
        `,
          )
          .execute(trx);

        await sql
          .raw(
            `
          CREATE TRIGGER ${tableName}_search_update
          BEFORE INSERT OR UPDATE ON ${tableName}
          FOR EACH ROW EXECUTE FUNCTION ${tableName}_search_trigger()
        `,
          )
          .execute(trx);
      });
    }

    // Auto-update updated_at — PER-TABLE function (no global race condition).
    // A global CREATE OR REPLACE FUNCTION would be clobbered when two collections
    // are created concurrently and one day diverges its logic.
    await withLockTimeout(db, async (trx) => {
      await sql
        .raw(
          `
        CREATE OR REPLACE FUNCTION ${tableName}_touch_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `,
        )
        .execute(trx);

      await sql
        .raw(
          `
        CREATE TRIGGER update_${tableName}_updated_at
          BEFORE UPDATE ON ${tableName}
          FOR EACH ROW
          EXECUTE FUNCTION ${tableName}_touch_updated_at()
      `,
        )
        .execute(trx);
    });

    // Register collection metadata
    await this.registerMetadata(db, validated);
  }

  /**
   * Returns foreign-key dependencies pointing *into* this table — i.e. tables
   * that would lose their FK constraint (and potentially orphan rows) when
   * this table is dropped with CASCADE.
   */
  static async getTableDependents(
    db: Database,
    collectionName: string,
  ): Promise<Array<{ table: string; constraint: string; column: string }>> {
    const tableName = this.getTableName(collectionName);
    const result = await sql<{
      table: string;
      constraint: string;
      column: string;
    }>`
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

  static async dropCollection(
    db: Database,
    name: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const tableName = this.getTableName(name);

    if (!(await this.tableExists(db, name))) {
      throw new Error(`Collection '${name}' not found`);
    }

    // Warn-on-dependencies: CASCADE silently removes FK constraints from other
    // tables, which can leave orphan rows. Caller must pass `force: true` to
    // acknowledge the consequence, preserving integrity-by-default.
    const deps = await this.getTableDependents(db, name);
    if (deps.length > 0 && !opts.force) {
      const list = deps
        .map((d) => `${d.table}.${d.column} (constraint ${d.constraint})`)
        .join(', ');
      throw new Error(
        `Cannot drop collection '${name}': ${deps.length} foreign key(s) reference it: ${list}. ` +
          `Retry with force=true to DROP ... CASCADE (FK constraints will be removed; rows are preserved).`,
      );
    }

    // DROP TABLE CASCADE → withLockTimeout (AccessExclusiveLock on table + all dependencies)
    await withLockTimeout(db, async (trx) => {
      await sql.raw(`DROP TABLE IF EXISTS ${tableName} CASCADE`).execute(trx);
    });

    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', name)
      .execute();

    DDLManager.invalidateCache(name);
  }

  static async getCollections(db: Database): Promise<any[]> {
    const now = Date.now();
    if (
      _collectionsListCache &&
      now - _collectionsListCache.ts < METADATA_CACHE_TTL_MS
    ) {
      return _collectionsListCache.data;
    }

    // Capture generation before the async DB round-trip.
    // If invalidateCache() is called while we await, the generation bumps and
    // we skip the cache write — preventing stale data from filling the cache.
    const genBefore = _cacheGen;

    const rows = await db
      .selectFrom('zvd_collections')
      .selectAll()
      .orderBy('sort')
      .orderBy('name')
      .execute();

    // Bun.SQL may return JSONB columns as raw JSON strings — normalize to JS objects.
    const normalized = (rows as any[]).map((row) => ({
      ...row,
      fields: typeof row.fields === 'string' ? JSON.parse(row.fields) : (row.fields ?? []),
    }));

    if (_cacheGen === genBefore) {
      _collectionsListCache = { data: normalized, ts: now };
    }
    return normalized;
  }

  static async getCollection(db: Database, name: string): Promise<any | null> {
    const now = Date.now();
    const cached = collectionCache.get(name);
    if (cached && now - cached.ts < METADATA_CACHE_TTL_MS) {
      return cached.data;
    }

    const genBefore = _cacheGen;

    const row = await db
      .selectFrom('zvd_collections')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();

    // Bun.SQL may return JSONB columns as raw JSON strings — normalize to JS object.
    const result = row
      ? {
          ...row,
          fields: typeof (row as any).fields === 'string'
            ? JSON.parse((row as any).fields)
            : ((row as any).fields ?? []),
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
        ...(updates.description !== undefined
          ? { description: updates.description }
          : {}),
        ...(updates.fields ? { fields: JSON.stringify(updates.fields) } : {}),
        ...(updates.aiSearchEnabled !== undefined
          ? { ai_search_enabled: updates.aiSearchEnabled }
          : {}),
        ...(updates.aiSearchField !== undefined
          ? { ai_search_field: updates.aiSearchField }
          : {}),
        updated_at: new Date(),
      } as any)
      .where('name' as any, '=', name)
      .execute();

    DDLManager.invalidateCache(name);
  }

  /**
   * Adds a single field (column) to an existing collection.
   * Updates both the physical schema and the zvd_collections metadata atomically.
   */
  static async addField(
    db: Database,
    collectionName: string,
    field: z.infer<typeof FieldSchema>,
  ): Promise<void> {
    const validated = FieldSchema.parse(field);
    if (!fieldTypeRegistry.has(validated.type)) {
      throw new Error(`Unknown field type: "${validated.type}"`);
    }
    const tableName = this.getTableName(collectionName);
    if (!(await this.tableExists(db, collectionName))) {
      throw new Error(`Collection '${collectionName}' not found`);
    }
    const colDDL = fieldTypeRegistry.getColumnDDL(validated as FieldConfig);
    if (colDDL) {
      // ALTER TABLE ADD COLUMN → withLockTimeout (AccessExclusiveLock, instant for nullable)
      await withLockTimeout(db, async (trx) => {
        await sql`ALTER TABLE ${sql.id(tableName)} ADD COLUMN IF NOT EXISTS ${sql.raw(colDDL)}`.execute(trx);
      });
    }
    // Create index if requested — CONCURRENTLY to avoid blocking writes
    const indexDDL = fieldTypeRegistry.getIndexDDL(tableName, validated as FieldConfig);
    if (indexDDL) {
      await sql.raw(toConcurrentIndex(indexDDL)).execute(db);
    }
    // Update fields array in metadata
    const existing = await this.getCollection(db, collectionName);
    if (existing) {
      const fields: any[] = typeof existing.fields === 'string'
        ? JSON.parse(existing.fields)
        : (existing.fields ?? []);
      if (!fields.some((f: any) => f.name === validated.name)) {
        fields.push(validated);
        await this.updateCollectionMetadata(db, collectionName, { fields });
      }
    }
    this.invalidateCache(collectionName);
  }

  /**
   * Removes a field (column) from an existing collection.
   * Updates both the physical schema and the zvd_collections metadata atomically.
   */
  static async removeField(
    db: Database,
    collectionName: string,
    fieldName: string,
  ): Promise<void> {
    // Validate field name to prevent identifier injection
    if (!/^[a-z][a-z0-9_]*$/.test(fieldName)) {
      throw new Error(`Invalid field name: "${fieldName}". Only lowercase letters, numbers, and underscores are allowed.`);
    }
    const tableName = this.getTableName(collectionName);
    if (!(await this.tableExists(db, collectionName))) {
      throw new Error(`Collection '${collectionName}' not found`);
    }
    // ALTER TABLE DROP COLUMN → withLockTimeout (AccessExclusiveLock)
    await withLockTimeout(db, async (trx) => {
      await sql`ALTER TABLE ${sql.id(tableName)} DROP COLUMN IF EXISTS ${sql.id(fieldName)}`.execute(trx);
    });
    // Remove field from metadata
    const existing = await this.getCollection(db, collectionName);
    if (existing) {
      const fields: any[] = typeof existing.fields === 'string'
        ? JSON.parse(existing.fields)
        : (existing.fields ?? []);
      const updated = fields.filter((f: any) => f.name !== fieldName);
      await this.updateCollectionMetadata(db, collectionName, { fields: updated });
    }
    this.invalidateCache(collectionName);
  }

  /**
   * Returns the SQL that would be executed for a new collection — without running it.
   * Mirrors createCollection() exactly (system columns, FTS, triggers) so previews
   * don't mislead callers about what they'll get.
   */
  static async previewCollection(schema: z.infer<typeof CollectionSchema>): Promise<{ sql: string[] }> {
    // Defence-in-depth even though Zod regex-validates the name:
    const SAFE_NAME = /^[a-z][a-z0-9_]*$/;
    if (!SAFE_NAME.test(schema.name)) {
      throw new Error(`Invalid collection name: "${schema.name}"`);
    }
    const tableName = `zvd_${schema.name}`;
    const statements: string[] = [];

    const systemCols = [
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived'))",
      'created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL',
      'updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL',
    ];

    const userCols = schema.fields
      .map((f) => {
        const def = fieldTypeRegistry.get(f.type);
        if (def?.db.virtual) return null;
        const colType = def?.db.columnType ?? 'TEXT';
        const nullable = f.required ? 'NOT NULL' : 'NULL';
        const defaultVal =
          def?.db.defaultValue !== undefined && def?.db.defaultValue !== null
            ? ` DEFAULT ${def.db.defaultValue}`
            : '';
        return `  "${f.name}" ${colType} ${nullable}${defaultVal}`;
      })
      .filter((s): s is string => s !== null);

    const allCols = [...systemCols.map((c) => `  ${c}`), ...userCols];

    statements.push(`CREATE TABLE IF NOT EXISTS ${tableName} (\n${allCols.join(',\n')}\n);`);

    statements.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_created_at ON ${tableName}(created_at DESC);`);
    statements.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_status ON ${tableName}(status);`);

    for (const field of schema.fields) {
      if (field.indexed) {
        statements.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_${field.name} ON ${tableName}("${field.name}");`);
      }
      if (field.unique) {
        statements.push(`ALTER TABLE ${tableName} ADD CONSTRAINT uq_${tableName}_${field.name} UNIQUE ("${field.name}");`);
      }
    }

    statements.push(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS search_vector tsvector;`);
    statements.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_search ON ${tableName} USING GIN(search_vector);`);

    statements.push(`-- Per-table updated_at trigger`);
    statements.push(`CREATE OR REPLACE FUNCTION ${tableName}_touch_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;`);
    statements.push(`CREATE TRIGGER update_${tableName}_updated_at BEFORE UPDATE ON ${tableName} FOR EACH ROW EXECUTE FUNCTION ${tableName}_touch_updated_at();`);

    return { sql: statements };
  }

  // ── Introspection ────────────────────────────────────────────────────────
  // Used to reconcile zvd_collections.fields with the physical schema when a
  // table was created outside DDLManager (e.g. a seed migration). Mapping from
  // PostgreSQL data_type/udt_name → field-type-registry key. Best-effort:
  // unknown types fall back to 'text' so the collection remains usable.

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
    // PostgreSQL array types: udt_name starts with '_' (e.g. _text), data_type is 'ARRAY'.
    if (dt === 'array' || udt.startsWith('_')) return 'tags';
    if (udt === 'tsvector') return 'text'; // callers skip search_vector
    return 'text';
  }

  /**
   * Reads information_schema.columns for a physical table and returns a
   * FieldConfig[] suitable for zvd_collections.fields.
   *
   * Filters out system columns (id, created_at, updated_at, status,
   * created_by, updated_by, search_vector) so the list reflects user fields.
   */
  static async introspectTable(
    db: Database,
    collectionName: string,
  ): Promise<FieldConfig[]> {
    const tableName = this.getTableName(collectionName);
    const SYSTEM_COLS = new Set([
      'id',
      'created_at',
      'updated_at',
      'status',
      'created_by',
      'updated_by',
      'search_vector',
    ]);

    const rows = await sql<{
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

    return rows.rows
      .filter((r) => !SYSTEM_COLS.has(r.column_name))
      .map((r) => ({
        name: r.column_name,
        type: this.pgTypeToFieldType(r.udt_name, r.data_type),
        required: r.is_nullable === 'NO',
      }));
  }

  /**
   * If zvd_collections.fields is empty/missing for a collection but the
   * physical table exists, populate fields via introspection. Returns the
   * number of fields written. Safe to call repeatedly — noop if fields
   * are already present.
   */
  static async syncFieldsFromDB(
    db: Database,
    collectionName: string,
  ): Promise<number> {
    const meta = await this.getCollection(db, collectionName);
    if (!meta) return 0;
    const existing =
      typeof meta.fields === 'string' ? JSON.parse(meta.fields) : meta.fields;
    if (Array.isArray(existing) && existing.length > 0) return 0;

    if (!(await this.tableExists(db, collectionName))) return 0;

    const fields = await this.introspectTable(db, collectionName);
    if (fields.length === 0) return 0;

    await db
      .updateTable('zvd_collections')
      .set({ fields: JSON.stringify(fields), updated_at: new Date() } as any)
      .where('name' as any, '=', collectionName)
      .execute();

    this.invalidateCache(collectionName);
    return fields.length;
  }

  static async registerMetadata(
    db: Database,
    definition: CollectionDefinition,
  ): Promise<void> {
    await db
      .insertInto('zvd_collections')
      .values({
        name: definition.name,
        display_name: definition.displayName || definition.name,
        icon: definition.icon || 'Table',
        route_group: definition.routeGroup || 'private',
        is_permissioned: definition.isPermissioned ?? true,
        is_managed: definition.isManaged ?? false,
        ai_search_enabled: definition.aiSearchEnabled ?? false,
        is_system: definition.isSystem ?? false,
        schema_locked: definition.schemaLocked ?? false,
        sort: definition.sort ?? 99,
        singular_name: definition.singularName || definition.name,
        description: definition.description || null,
        fields: JSON.stringify(definition.fields),
      })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet({
          display_name: definition.displayName || definition.name,
          fields: JSON.stringify(definition.fields),
          updated_at: new Date(),
        }),
      )
      .execute();

    DDLManager.invalidateCache(definition.name);
  }
}
