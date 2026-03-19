import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { fieldTypeRegistry, type FieldConfig } from './field-type-registry.js';

// ─── Safe DDL helpers ─────────────────────────────────────────────────────────

/**
 * Execută o operație DDL care necesită AccessExclusiveLock (ALTER TABLE,
 * CREATE TRIGGER, DROP TABLE) într-o tranzacție cu lock_timeout strict.
 *
 * SET LOCAL → timeout-ul se aplică NUMAI în această tranzacție; la COMMIT
 * conexiunea din pool revine la setarea default (fără timeout).
 *
 * Dacă lock-ul nu poate fi obținut în `timeout`, PostgreSQL aruncă
 * `ERROR 55P03: lock not available` în loc să blocheze event loop-ul.
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
 * Transformă un CREATE INDEX în CREATE INDEX CONCURRENTLY.
 *
 * CONCURRENTLY folosește ShareUpdateExclusiveLock în loc de ShareLock,
 * permițând INSERT/UPDATE/DELETE concurente în timp ce index-ul se construiește.
 * Nu poate rula în interiorul unui bloc de tranzacție explicit.
 */
function toConcurrentIndex(indexSQL: string): string {
  // Regex handle-uiește și CREATE UNIQUE INDEX
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
  options: z.record(z.string().max(100), z.union([z.string().max(10_000), z.number(), z.boolean(), z.null(), z.array(z.any())])).optional(),
  label: z.string().max(200).optional(),
  description: z.string().max(1_000).optional(),
});

export const CollectionSchema = z.object({
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
  fields: z.array(FieldSchema).min(1),
  description: z.string().optional(),
  singularName: z.string().optional(),
  aiSearchEnabled: z.boolean().optional(),
  aiSearchField: z.string().nullable().optional(),
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

export class DDLManager {
  static getTableName(collectionName: string): string {
    return `zvd_${collectionName}`;
  }

  /** Invalidates the in-memory cache for a specific collection (call after DDL mutations). */
  static invalidateCache(name?: string): void {
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

  static async createCollection(db: Database, definition: CollectionDefinition): Promise<void> {
    const validated = CollectionSchema.parse(definition);

    // Validate all field types are registered
    for (const field of validated.fields) {
      if (!fieldTypeRegistry.has(field.type)) {
        throw new Error(`Unknown field type: "${field.type}". Available types: ${fieldTypeRegistry.list().join(', ')}`);
      }
    }

    const tableName = this.getTableName(validated.name);

    // N4: defense-in-depth — ensure tableName is safe before any sql.raw() usage.
    // validated.name is already regex-checked by Zod, but a future refactor could
    // introduce a different code path. This guard prevents sql injection if it does.
    const SAFE_TABLE_RE = /^zvd_[a-z][a-z0-9_]*$/;
    if (!SAFE_TABLE_RE.test(tableName)) {
      throw new Error(`Invalid table name: "${tableName}". Only lowercase letters, numbers, and underscores are allowed.`);
    }

    if (await this.tableExists(db, validated.name)) {
      throw new Error(`Collection '${validated.name}' already exists`);
    }

    // Base columns
    const columns: string[] = [
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'status TEXT NOT NULL DEFAULT \'active\' CHECK (status IN (\'active\', \'draft\', \'archived\'))',
      'created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL',
      'updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL',
    ];

    const indexes: string[] = [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_created_at ON ${tableName}(created_at DESC)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_status ON ${tableName}(status)`,
    ];

    // Security: whitelist of allowed PostgreSQL extensions.
    const ALLOWED_PG_EXTENSIONS = new Set([
      'pgvector',        // AI embeddings
      'postgis',         // Geospatial
      'postgis_topology',
      'uuid-ossp',       // UUID generation
      'pg_trgm',         // Trigram similarity search
      'unaccent',        // Text search accent normalization
      'btree_gist',      // GiST indexes for B-tree types
      'btree_gin',       // GIN indexes for B-tree types
      'hstore',          // Key-value store column type
      'citext',          // Case-insensitive text
      'intarray',        // Integer array operations
      'fuzzystrmatch',   // Fuzzy string matching
    ]);

    // Ensure required extensions
    const requiredExtensions = fieldTypeRegistry.getRequiredExtensions(validated.fields as FieldConfig[]);
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
      const indexDDL = fieldTypeRegistry.getIndexDDL(tableName, field as FieldConfig);
      if (indexDDL) indexes.push(toConcurrentIndex(indexDDL));
    }

    // Create table
    await sql.raw(`
      CREATE TABLE ${tableName} (
        ${columns.join(',\n        ')}
      )
    `).execute(db);

    // Create indexes
    for (const indexSQL of indexes) {
      await sql.raw(indexSQL).execute(db);
    }

    // Full-text search vector
    const textFields = validated.fields
      .filter((f) => ['text', 'richtext', 'email'].includes(f.type))
      .map((f) => f.name);

    // ALTER TABLE → lock_timeout (AccessExclusiveLock, instant pentru coloană nullable fără default)
    await withLockTimeout(db, async (trx) => {
      await sql.raw(`
        ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS search_vector tsvector
      `).execute(trx);
    });

    // GIN index → CONCURRENTLY (nu blochează scrierile în timp ce se construiește)
    await sql.raw(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_search ON ${tableName} USING GIN(search_vector)
    `).execute(db);

    if (textFields.length > 0) {
      const weightsClause = textFields
        .map((f, i) => {
          const weight = i === 0 ? 'A' : i === 1 ? 'B' : i === 2 ? 'C' : 'D';
          return `setweight(to_tsvector('english', coalesce("${f}", '')), '${weight}')`;
        })
        .join(' || ');

      // CREATE OR REPLACE FUNCTION + CREATE TRIGGER → withLockTimeout (ShareRowExclusiveLock)
      await withLockTimeout(db, async (trx) => {
        await sql.raw(`
          CREATE OR REPLACE FUNCTION ${tableName}_search_trigger() RETURNS trigger AS $$
          BEGIN
            NEW.search_vector := ${weightsClause};
            RETURN NEW;
          END
          $$ LANGUAGE plpgsql
        `).execute(trx);

        await sql.raw(`
          CREATE TRIGGER ${tableName}_search_update
          BEFORE INSERT OR UPDATE ON ${tableName}
          FOR EACH ROW EXECUTE FUNCTION ${tableName}_search_trigger()
        `).execute(trx);
      });
    }

    // Auto-update updated_at — CREATE TRIGGER → withLockTimeout
    await withLockTimeout(db, async (trx) => {
      await sql.raw(`
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `).execute(trx);

      await sql.raw(`
        CREATE TRIGGER update_${tableName}_updated_at
          BEFORE UPDATE ON ${tableName}
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column()
      `).execute(trx);
    });

    // Register collection metadata
    await this.registerMetadata(db, validated);
  }

  static async dropCollection(db: Database, name: string): Promise<void> {
    const tableName = this.getTableName(name);

    if (!(await this.tableExists(db, name))) {
      throw new Error(`Collection '${name}' not found`);
    }

    // DROP TABLE CASCADE → withLockTimeout (AccessExclusiveLock pe tabelă + toate dependințele)
    await withLockTimeout(db, async (trx) => {
      await sql.raw(`DROP TABLE IF EXISTS ${tableName} CASCADE`).execute(trx);
    });

    await db
      .deleteFrom('zvd_collections' as any)
      .where('name' as any, '=', name)
      .execute();

    DDLManager.invalidateCache(name);
  }

  static async getCollections(db: Database): Promise<any[]> {
    const now = Date.now();
    if (_collectionsListCache && now - _collectionsListCache.ts < METADATA_CACHE_TTL_MS) {
      return _collectionsListCache.data;
    }

    const rows = await db
      .selectFrom('zvd_collections' as any)
      .selectAll()
      .orderBy('sort' as any)
      .orderBy('name' as any)
      .execute();

    _collectionsListCache = { data: rows, ts: now };
    return rows;
  }

  static async getCollection(db: Database, name: string): Promise<any | null> {
    const now = Date.now();
    const cached = collectionCache.get(name);
    if (cached && now - cached.ts < METADATA_CACHE_TTL_MS) {
      return cached.data;
    }

    const row = await db
      .selectFrom('zvd_collections' as any)
      .selectAll()
      .where('name' as any, '=', name)
      .executeTakeFirst();

    const result = row || null;
    collectionCache.set(name, { data: result, ts: now });
    return result;
  }

  static async updateCollectionMetadata(
    db: Database,
    name: string,
    updates: Partial<CollectionDefinition>,
  ): Promise<void> {
    await db
      .updateTable('zvd_collections' as any)
      .set({
        ...(updates.displayName ? { display_name: updates.displayName } : {}),
        ...(updates.icon ? { icon: updates.icon } : {}),
        ...(updates.description !== undefined ? { description: updates.description } : {}),
        ...(updates.fields ? { fields: JSON.stringify(updates.fields) } : {}),
        ...(updates.aiSearchEnabled !== undefined ? { ai_search_enabled: updates.aiSearchEnabled } : {}),
        ...(updates.aiSearchField !== undefined ? { ai_search_field: updates.aiSearchField } : {}),
        updated_at: new Date(),
      } as any)
      .where('name' as any, '=', name)
      .execute();

    DDLManager.invalidateCache(name);
  }

  private static async registerMetadata(db: Database, definition: CollectionDefinition): Promise<void> {
    await db
      .insertInto('zvd_collections' as any)
      .values({
        name: definition.name,
        display_name: definition.displayName || definition.name,
        icon: definition.icon || 'Table',
        route_group: definition.routeGroup || 'private',
        is_permissioned: definition.isPermissioned ?? true,
        sort: definition.sort ?? 99,
        singular_name: definition.singularName || definition.name,
        description: definition.description || null,
        fields: JSON.stringify(definition.fields),
      } as any)
      .onConflict((oc) =>
        oc.column('name' as any).doUpdateSet({
          display_name: definition.displayName || definition.name,
          fields: JSON.stringify(definition.fields),
          updated_at: new Date(),
        } as any),
      )
      .execute();

    DDLManager.invalidateCache(definition.name);
  }
}
