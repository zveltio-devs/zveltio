/**
 * BYOD Introspection Engine
 *
 * Scanează un schema PostgreSQL, mapează tipurile PG → Zveltio,
 * și importă tabelele ca „unmanaged collections" (is_managed = false).
 * Zveltio NU va face ALTER TABLE pe aceste tabele.
 */

import { sql } from 'kysely';
import type { Database } from '../db/index.js';

// Mapare PG data_type → tip Zveltio
const PG_TYPE_MAP: Record<string, string> = {
  text: 'text',
  'character varying': 'text',
  varchar: 'text',
  char: 'text',
  bpchar: 'text',
  name: 'text',
  integer: 'number',
  int4: 'number',
  int2: 'number',
  smallint: 'number',
  bigint: 'number',
  int8: 'number',
  numeric: 'number',
  decimal: 'number',
  real: 'number',
  float4: 'number',
  float8: 'number',
  'double precision': 'number',
  boolean: 'boolean',
  bool: 'boolean',
  date: 'date',
  'timestamp without time zone': 'datetime',
  'timestamp with time zone': 'datetime',
  timestamptz: 'datetime',
  timestamp: 'datetime',
  json: 'json',
  jsonb: 'json',
  uuid: 'uuid',
};

function mapPgType(pgType: string): string {
  return PG_TYPE_MAP[pgType.toLowerCase()] ?? 'text';
}

// Prefixe de tabele Zveltio/sistem — nu le importăm niciodată
const PLATFORM_PREFIXES = ['zv_', 'zvd_', '_zv_', 'pg_'];

function isPlatformTable(tableName: string): boolean {
  return PLATFORM_PREFIXES.some((p) => tableName.startsWith(p));
}

export interface IntrospectedTable {
  tableName: string;
  collectionName: string;
  fieldsCount: number;
  isNew: boolean; // true dacă a fost insertat acum, false dacă era deja înregistrat
}

/**
 * Introspectează `schemaName` și importă tabelele găsite ca unmanaged collections.
 *
 * @param db          Kysely Database instance
 * @param schemaName  Schema PostgreSQL de scanat (default: 'public')
 * @param excludePatterns  Subșiruri — tabelele care le conțin sunt ignorate
 * @param dryRun      Dacă true, returnează rezultatul fără a scrie în DB
 */
export async function introspectSchema(
  db: Database,
  schemaName = 'public',
  excludePatterns: string[] = [],
  dryRun = false,
): Promise<IntrospectedTable[]> {
  // Găsim tabelele distincte din schema dată
  const tablesResult = await sql<{ table_name: string }>`
    SELECT DISTINCT table_name
    FROM information_schema.columns
    WHERE table_schema = ${schemaName}
    ORDER BY table_name
  `.execute(db);

  const results: IntrospectedTable[] = [];

  for (const { table_name } of tablesResult.rows) {
    // Skip tabele platform și pattern-uri excluse
    if (isPlatformTable(table_name)) continue;
    if (excludePatterns.some((p) => table_name.includes(p))) continue;

    // Preluăm coloanele tabelului
    const colsResult = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = ${schemaName}
        AND table_name = ${table_name}
      ORDER BY ordinal_position
    `.execute(db);

    if (colsResult.rows.length === 0) continue;

    // Construim array-ul de fields în formatul Zveltio
    const fields = colsResult.rows.map((col) => ({
      name: col.column_name,
      type: mapPgType(col.data_type),
      required: col.is_nullable === 'NO' && col.column_default === null,
      unique: false,
      indexed: false,
      label: col.column_name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
    }));

    // Dacă e dry-run, colectăm doar preview-ul
    if (dryRun) {
      results.push({ tableName: table_name, collectionName: table_name, fieldsCount: fields.length, isNew: true });
      continue;
    }

    // Upsert în zvd_collections
    const existing = await (db as any)
      .selectFrom('zvd_collections')
      .select('id')
      .where('name', '=', table_name)
      .executeTakeFirst()
      .catch(() => null);

    if (existing) {
      // Actualizăm fields dar NU schimbăm is_managed — poate era deja managed
      await (db as any)
        .updateTable('zvd_collections')
        .set({ fields: JSON.stringify(fields), updated_at: new Date() })
        .where('name', '=', table_name)
        .execute();
      results.push({ tableName: table_name, collectionName: table_name, fieldsCount: fields.length, isNew: false });
    } else {
      const displayName = table_name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());

      await (db as any)
        .insertInto('zvd_collections')
        .values({
          name: table_name,
          display_name: displayName,
          fields: JSON.stringify(fields),
          is_managed: false,
          source_type: 'table',
        })
        .execute();
      results.push({ tableName: table_name, collectionName: table_name, fieldsCount: fields.length, isNew: true });
    }
  }

  return results;
}
