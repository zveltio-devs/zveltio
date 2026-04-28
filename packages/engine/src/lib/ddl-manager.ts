import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { fieldTypeRegistry, type FieldConfig } from './field-type-registry.js';

// ─── Relation type sets ───────────────────────────────────────────────────────
/** FK column lives in the SOURCE table (the collection being modified). */
const RELATION_FK_TYPES = new Set(['m2o', 'reference']);
/** FK column lives in the TARGET table (reverse side of o2m). */
const REVERSE_FK_TYPES  = new Set(['o2m']);
const ON_DELETE_SAFE    = new Set(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']);
const SAFE_NAME_RE      = /^[a-z][a-z0-9_]*$/;

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
  await (db as any).transaction().execute(async (trx: Database) => {
    await sql.raw(`SET LOCAL lock_timeout = '${timeout}'`).execute(trx);
    await fn(trx);
  });
}

function toConcurrentIndex(indexSQL: string): string {
  return indexSQL.replace(
    /^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)(?!CONCURRENTLY\s)/i,
    '$1CONCURRENTLY ',
  );
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

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
  isManaged: z.boolean().optional(),
  isSystem: z.boolean().optional(),
  schemaLocked: z.boolean().optional(),
});

export type CollectionDefinition = z.infer<typeof CollectionSchema>;

// ─── In-memory metadata cache ──────────────────────────────────────────────────

const METADATA_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  data: any;
  ts: number;
}

const collectionCache = new Map<string, CacheEntry>();
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
   * Must be called OUTSIDE an open transaction (CONCURRENTLY requires that).
   */
  static async applyRelationFK(
    db: Database,
    tableName: string,
    fieldName: string,
    targetTable: string,
    onDelete = 'SET NULL',
    onUpdate  = 'CASCADE',
  ): Promise<void> {
    const od = onDelete.toUpperCase();
    const ou = onUpdate.toUpperCase();
    if (!ON_DELETE_SAFE.has(od) || !ON_DELETE_SAFE.has(ou)) {
      throw new Error(`Invalid on_delete/on_update value: ${od}/${ou}`);
    }
    await withLockTimeout(db, async (trx) => {
      await sql.raw(
        `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${fieldName}" UUID ` +
        `REFERENCES "${targetTable}"(id) ON DELETE ${od} ON UPDATE ${ou}`,
      ).execute(trx);
    });
    // Index the FK column for join performance
    await sql.raw(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_${fieldName} ` +
      `ON "${tableName}"("${fieldName}")`,
    ).execute(db);
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
    },
  ): Promise<void> {
    await (db as any)
      .insertInto('zvd_relations')
      .values(rel)
      .onConflict((oc: any) => oc.doNothing())
      .execute()
      .catch((err: any) => console.warn('[registerRelation]', err?.message ?? err));
  }

  // ── createCollection ─────────────────────────────────────────────────────────

  static async createCollection(db: Database, definition: CollectionDefinition): Promise<void> {
    const validated = CollectionSchema.parse(definition);

    for (const field of validated.fields) {
      if (!fieldTypeRegistry.has(field.type)) {
        throw new Error(
          `Unknown field type: "${field.type}". Available types: ${fieldTypeRegistry.list().join(', ')}`,
        );
      }
      // Bug #4: validate related_collection is present for relation fields
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

    // Bug #1: separate relation fields (FK column added post-table) from regular fields
    const relationFields = validated.fields.filter(
      (f) => RELATION_FK_TYPES.has(f.type) && f.options?.related_collection,
    );
    const regularFields = validated.fields.filter(
      (f) => !RELATION_FK_TYPES.has(f.type) || !f.options?.related_collection,
    );

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

    const ALLOWED_PG_EXTENSIONS = new Set([
      'pgvector', 'postgis', 'postgis_topology', 'uuid-ossp', 'pg_trgm',
      'unaccent', 'btree_gist', 'btree_gin', 'hstore', 'citext', 'intarray', 'fuzzystrmatch',
    ]);

    const requiredExtensions = fieldTypeRegistry.getRequiredExtensions(regularFields as FieldConfig[]);
    for (const ext of requiredExtensions) {
      if (!ALLOWED_PG_EXTENSIONS.has(ext)) {
        throw new Error(`PostgreSQL extension "${ext}" is not in the allowed extensions whitelist.`);
      }
      await sql`CREATE EXTENSION IF NOT EXISTS ${sql.id(ext)}`.execute(db);
    }

    for (const field of regularFields) {
      const colDDL = fieldTypeRegistry.getColumnDDL(field as FieldConfig);
      if (!colDDL) continue;
      columns.push(colDDL);
      // Bug #7: create index for unique/indexed regular fields
      const indexDDL = fieldTypeRegistry.getIndexDDL(tableName, field as FieldConfig);
      if (indexDDL) indexes.push(toConcurrentIndex(indexDDL));
    }

    await sql.raw(`CREATE TABLE ${tableName} (\n  ${columns.join(',\n  ')}\n)`).execute(db);

    for (const indexSQL of indexes) {
      await sql.raw(indexSQL).execute(db);
    }

    // FTS support
    const textFields = regularFields
      .filter((f) => ['text', 'richtext', 'email'].includes(f.type))
      .map((f) => f.name);

    await withLockTimeout(db, async (trx) => {
      await sql.raw(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS search_vector tsvector`).execute(trx);
    });
    await sql.raw(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_search ON ${tableName} USING GIN(search_vector)`,
    ).execute(db);

    if (textFields.length > 0) {
      const weightsClause = textFields
        .map((f, i) => {
          const weight = i === 0 ? 'A' : i === 1 ? 'B' : i === 2 ? 'C' : 'D';
          return `setweight(to_tsvector('english', coalesce(NEW."${f}", '')), '${weight}')`;
        })
        .join(' || ');

      const searchTextConcat = textFields.length === 1
        ? `coalesce(NEW."${textFields[0]}", '')`
        : `concat_ws(' ', ${textFields.map((f) => `coalesce(NEW."${f}", '')`).join(', ')})`;

      await withLockTimeout(db, async (trx) => {
        await sql.raw(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS search_text text`).execute(trx);
      });
      await sql.raw(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_trgm ON ${tableName} USING GIN(search_text gin_trgm_ops)`,
      ).execute(db);

      await withLockTimeout(db, async (trx) => {
        await sql.raw(`
          CREATE OR REPLACE FUNCTION ${tableName}_search_trigger() RETURNS trigger AS $$
          BEGIN
            NEW.search_vector := ${weightsClause};
            NEW.search_text := ${searchTextConcat};
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

    await withLockTimeout(db, async (trx) => {
      await sql.raw(`
        CREATE OR REPLACE FUNCTION ${tableName}_touch_updated_at()
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
          EXECUTE FUNCTION ${tableName}_touch_updated_at()
      `).execute(trx);
    });

    // Register metadata first so relation inserts can reference valid collection names
    await this.registerMetadata(db, validated);

    if (textFields.length > 0) {
      await (db as any)
        .updateTable('zvd_collections')
        .set({ has_trgm: true })
        .where('name', '=', validated.name)
        .execute();
    }

    // Bug #1: add FK columns and register relations after table + metadata exist
    for (const field of relationFields) {
      const target = String(field.options!.related_collection);
      if (!SAFE_NAME_RE.test(target)) {
        console.warn(`[createCollection] Invalid target name '${target}' for field '${field.name}' — skipping`);
        continue;
      }
      if (!(await this.tableExists(db, target))) {
        console.warn(`[createCollection] Target '${target}' for field '${field.name}' not found — skipping FK`);
        continue;
      }
      const targetTable = this.getTableName(target);
      const onDelete = String(field.options?.on_delete ?? 'SET NULL').toUpperCase();
      const onUpdate = String(field.options?.on_update ?? 'CASCADE').toUpperCase();

      await this.applyRelationFK(db, tableName, field.name, targetTable, onDelete, onUpdate);
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

  // ── dropCollection ───────────────────────────────────────────────────────────

  static async dropCollection(
    db: Database,
    name: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const tableName = this.getTableName(name);

    if (!(await this.tableExists(db, name))) {
      throw new Error(`Collection '${name}' not found`);
    }

    const deps = await this.getTableDependents(db, name);
    if (deps.length > 0 && !opts.force) {
      const list = deps.map((d) => `${d.table}.${d.column} (constraint ${d.constraint})`).join(', ');
      throw new Error(
        `Cannot drop collection '${name}': ${deps.length} foreign key(s) reference it: ${list}. ` +
        `Retry with force=true to DROP ... CASCADE.`,
      );
    }

    // Bug #3: drop m2m junction tables before dropping the main table
    const m2mRelations: any[] = await (db as any)
      .selectFrom('zvd_relations')
      .selectAll()
      .where((eb: any) => eb.or([
        eb('source_collection', '=', name),
        eb('target_collection', '=', name),
      ]))
      .where('type', '=', 'm2m')
      .execute()
      .catch(() => []);

    for (const rel of m2mRelations) {
      const junctionName = `zvd_${rel.source_collection}_${rel.target_collection}`;
      await withLockTimeout(db, async (trx) => {
        await sql.raw(`DROP TABLE IF EXISTS "${junctionName}" CASCADE`).execute(trx);
      }).catch(() => {});
    }

    await withLockTimeout(db, async (trx) => {
      await sql.raw(`DROP TABLE IF EXISTS ${tableName} CASCADE`).execute(trx);
    });

    // Bug #3: clean up relation metadata (both sides)
    await (db as any)
      .deleteFrom('zvd_relations')
      .where((eb: any) => eb.or([
        eb('source_collection', '=', name),
        eb('target_collection', '=', name),
      ]))
      .execute()
      .catch(() => {});

    await db.deleteFrom('zvd_collections').where('name', '=', name).execute();

    DDLManager.invalidateCache(name);
  }

  // ── getCollections / getCollection ───────────────────────────────────────────

  static async getCollections(db: Database): Promise<any[]> {
    const now = Date.now();
    if (_collectionsListCache && now - _collectionsListCache.ts < METADATA_CACHE_TTL_MS) {
      return _collectionsListCache.data;
    }
    const genBefore = _cacheGen;
    const rows = await db.selectFrom('zvd_collections').selectAll().orderBy('sort').orderBy('name').execute();
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
    if (cached && now - cached.ts < METADATA_CACHE_TTL_MS) return cached.data;
    const genBefore = _cacheGen;
    const row = await db.selectFrom('zvd_collections').selectAll().where('name', '=', name).executeTakeFirst();
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

  // ── addField ─────────────────────────────────────────────────────────────────

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
      await withLockTimeout(db, async (trx) => {
        await sql`ALTER TABLE ${sql.id(tableName)} ADD COLUMN IF NOT EXISTS ${sql.raw(colDDL)}`.execute(trx);
      });
    }
    const indexDDL = fieldTypeRegistry.getIndexDDL(tableName, validated as FieldConfig);
    if (indexDDL) {
      await sql.raw(toConcurrentIndex(indexDDL)).execute(db);
    }
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

  // ── removeField ──────────────────────────────────────────────────────────────

  static async removeField(db: Database, collectionName: string, fieldName: string): Promise<void> {
    if (!/^[a-z][a-z0-9_]*$/.test(fieldName)) {
      throw new Error(`Invalid field name: "${fieldName}".`);
    }
    const tableName = this.getTableName(collectionName);
    if (!(await this.tableExists(db, collectionName))) {
      throw new Error(`Collection '${collectionName}' not found`);
    }
    await withLockTimeout(db, async (trx) => {
      await sql`ALTER TABLE ${sql.id(tableName)} DROP COLUMN IF EXISTS ${sql.id(fieldName)}`.execute(trx);
    });
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

  // ── previewCollection ────────────────────────────────────────────────────────

  /** Bug #9: includes FK constraints for relation fields in preview SQL. */
  static async previewCollection(schema: z.infer<typeof CollectionSchema>): Promise<{ sql: string[] }> {
    const SAFE_NAME = /^[a-z][a-z0-9_]*$/;
    if (!SAFE_NAME.test(schema.name)) throw new Error(`Invalid collection name: "${schema.name}"`);
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
        // Relation fields: show FK column in preview
        if (RELATION_FK_TYPES.has(f.type) && f.options?.related_collection) {
          const targetTable = `zvd_${f.options.related_collection}`;
          const onDelete = String(f.options?.on_delete ?? 'SET NULL').toUpperCase();
          return `  "${f.name}" UUID REFERENCES "${targetTable}"(id) ON DELETE ${onDelete}`;
        }
        const def = fieldTypeRegistry.get(f.type);
        if (def?.db.virtual) return null;
        const colType = def?.db.columnType ?? 'TEXT';
        const nullable = f.required ? 'NOT NULL' : 'NULL';
        const defaultVal = def?.db.defaultValue !== undefined && def?.db.defaultValue !== null
          ? ` DEFAULT ${def.db.defaultValue}`
          : '';
        return `  "${f.name}" ${colType} ${nullable}${defaultVal}`;
      })
      .filter((s): s is string => s !== null);

    statements.push(
      `CREATE TABLE IF NOT EXISTS ${tableName} (\n${[...systemCols.map((c) => `  ${c}`), ...userCols].join(',\n')}\n);`,
    );

    statements.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_created_at ON ${tableName}(created_at DESC);`);
    statements.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_status ON ${tableName}(status);`);

    for (const field of schema.fields) {
      if (RELATION_FK_TYPES.has(field.type)) {
        statements.push(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_${field.name} ON ${tableName}("${field.name}");`);
        continue;
      }
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

    // Show relation registrations in preview
    const relFields = schema.fields.filter((f) => RELATION_FK_TYPES.has(f.type) && f.options?.related_collection);
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
   * Bug #10: reads FK metadata from information_schema to detect relation fields
   * and populate options.related_collection on introspected fields.
   */
  static async introspectTable(db: Database, collectionName: string): Promise<FieldConfig[]> {
    const tableName = this.getTableName(collectionName);
    const SYSTEM_COLS = new Set([
      'id', 'created_at', 'updated_at', 'status', 'created_by', 'updated_by',
      'search_vector', 'search_text',
    ]);

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

    // Bug #10: fetch FK references for this table
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
      .set({ fields: JSON.stringify(fields), updated_at: new Date() } as any)
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
