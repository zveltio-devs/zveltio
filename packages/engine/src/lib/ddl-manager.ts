import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { fieldTypeRegistry, type FieldConfig } from './field-type-registry.js';

// Schema validation using registry types (dynamic, supports extension types)
export const FieldSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      'Field name must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
    ),
  type: z.string(), // validated at runtime against registry
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  indexed: z.boolean().default(false),
  defaultValue: z.any().optional(),
  options: z.record(z.string(), z.any()).optional(),
  label: z.string().optional(),
  description: z.string().optional(),
});

export const CollectionSchema = z.object({
  name: z
    .string()
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

export class DDLManager {
  static getTableName(collectionName: string): string {
    return `zvd_${collectionName}`;
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
      `CREATE INDEX IF NOT EXISTS idx_${tableName}_created_at ON ${tableName}(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_${tableName}_status ON ${tableName}(status)`,
    ];

    // Ensure required extensions
    const requiredExtensions = fieldTypeRegistry.getRequiredExtensions(validated.fields as FieldConfig[]);
    for (const ext of requiredExtensions) {
      await sql.raw(`CREATE EXTENSION IF NOT EXISTS ${ext}`).execute(db);
    }

    // Build column definitions using FieldTypeRegistry
    for (const field of validated.fields) {
      const colDDL = fieldTypeRegistry.getColumnDDL(field as FieldConfig);
      if (!colDDL) continue; // virtual/computed — skip

      columns.push(colDDL);

      // Index if requested
      const indexDDL = fieldTypeRegistry.getIndexDDL(tableName, field as FieldConfig);
      if (indexDDL) indexes.push(indexDDL);
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

    await sql.raw(`
      ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS search_vector tsvector
    `).execute(db);

    await sql.raw(`
      CREATE INDEX IF NOT EXISTS idx_${tableName}_search ON ${tableName} USING GIN(search_vector)
    `).execute(db);

    if (textFields.length > 0) {
      const weightsClause = textFields
        .map((f, i) => {
          const weight = i === 0 ? 'A' : i === 1 ? 'B' : i === 2 ? 'C' : 'D';
          return `setweight(to_tsvector('english', coalesce("${f}", '')), '${weight}')`;
        })
        .join(' || ');

      await sql.raw(`
        CREATE OR REPLACE FUNCTION ${tableName}_search_trigger() RETURNS trigger AS $$
        BEGIN
          NEW.search_vector := ${weightsClause};
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql
      `).execute(db);

      await sql.raw(`
        CREATE TRIGGER ${tableName}_search_update
        BEFORE INSERT OR UPDATE ON ${tableName}
        FOR EACH ROW EXECUTE FUNCTION ${tableName}_search_trigger()
      `).execute(db);
    }

    // Auto-update updated_at
    await sql.raw(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER update_${tableName}_updated_at
        BEFORE UPDATE ON ${tableName}
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    `).execute(db);

    // Register collection metadata
    await this.registerMetadata(db, validated);
  }

  static async dropCollection(db: Database, name: string): Promise<void> {
    const tableName = this.getTableName(name);

    if (!(await this.tableExists(db, name))) {
      throw new Error(`Collection '${name}' not found`);
    }

    await sql.raw(`DROP TABLE IF EXISTS ${tableName} CASCADE`).execute(db);

    await db
      .deleteFrom('zvd_collections' as any)
      .where('name' as any, '=', name)
      .execute();
  }

  static async getCollections(db: Database): Promise<any[]> {
    const rows = await db
      .selectFrom('zvd_collections' as any)
      .selectAll()
      .orderBy('sort' as any)
      .orderBy('name' as any)
      .execute();
    return rows;
  }

  static async getCollection(db: Database, name: string): Promise<any | null> {
    const row = await db
      .selectFrom('zvd_collections' as any)
      .selectAll()
      .where('name' as any, '=', name)
      .executeTakeFirst();
    return row || null;
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
  }
}
