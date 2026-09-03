/**
 * BYOD Introspection Engine
 *
 * Scans a PostgreSQL schema, maps PG types → Zveltio,
 * and imports tables as "unmanaged collections" (is_managed = false).
 * Zveltio will NOT run ALTER TABLE on these tables.
 */

import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { toJsonb } from './jsonb.js';

// PG data_type → Zveltio type mapping
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

// Zveltio/system table prefixes — never import these
const PLATFORM_PREFIXES = ['zv_', 'zvd_', '_zv_', 'pg_'];

/**
 * The platform's own tables that carry NO prefix.
 *
 * A prefix test alone is a denylist over an open namespace, and the engine's
 * most sensitive tables are exactly the ones outside it: Better-Auth creates
 * `user`, `session`, `account`, `verification`, `twoFactor` and `passkey`
 * unprefixed in
 * `public` (`db/migrations/sql/001_initial.sql`). None matches a prefix, so
 * importing the default schema registered them as ordinary collections with
 * `is_managed = false`.
 *
 * That is not merely untidy. They then appear in the Studio collection list and
 * are addressable through the generic record API, which resolves `:collection`
 * from the URL with no allowlist. Deny-by-default means a grant is needed first
 * — but the import is what turns "grant the Support role read on a collection"
 * into one-click disclosure of `account.password` hashes and `session.token`
 * bearer values, and a write grant on `session` is session forgery.
 * `is_managed = false` blocks Zveltio's DDL, not its DML.
 *
 * Same shape as the worker SQL bridge and the AI text-to-SQL validator, both
 * fixed by inversion. Inversion is not available here — importing tables nobody
 * has seen before is the entire point of this feature — so the platform's own
 * names are enumerated instead, and `introspection-covers-engine-tables.test.ts`
 * fails if a migration ever adds an unprefixed table that is not in this list.
 */
const PLATFORM_TABLES = new Set([
  'user',
  'session',
  'account',
  'verification',
  'twoFactor',
  // `passkey` arrived with migration 002 and is unprefixed like the rest of
  // Better Auth's tables. Without it here, introspection would offer it as an
  // ordinary collection and the generic record API would hand out
  // `publicKey`, `credentialID` and `counter` to anyone granted it.
  'passkey',
]);

export function isPlatformTable(tableName: string): boolean {
  if (PLATFORM_TABLES.has(tableName)) return true;
  // Case-insensitively too: PostgreSQL folds unquoted identifiers, so a table
  // created as `TwoFactor` and one created as `twofactor` are the same table,
  // and `twoFactor` only survives here because 001 quotes it.
  const lower = tableName.toLowerCase();
  for (const t of PLATFORM_TABLES) if (t.toLowerCase() === lower) return true;
  return PLATFORM_PREFIXES.some((p) => tableName.startsWith(p));
}

export interface IntrospectedTable {
  tableName: string;
  collectionName: string;
  fieldsCount: number;
  isNew: boolean; // true if inserted now, false if already registered
}

/**
 * Introspects `schemaName` and imports found tables as unmanaged collections.
 *
 * @param db          Kysely Database instance
 * @param schemaName  PostgreSQL schema to scan (default: 'public')
 * @param excludePatterns  Substrings — tables containing these are ignored
 * @param dryRun      If true, returns result without writing to DB
 */
export async function introspectSchema(
  db: Database,
  schemaName = 'public',
  excludePatterns: string[] = [],
  dryRun = false,
): Promise<IntrospectedTable[]> {
  // Find distinct tables in the given schema
  const tablesResult = await sql<{ table_name: string }>`
    SELECT DISTINCT table_name
    FROM information_schema.columns
    WHERE table_schema = ${schemaName}
    ORDER BY table_name
  `.execute(db);

  const results: IntrospectedTable[] = [];

  for (const { table_name } of tablesResult.rows) {
    // Skip platform tables and excluded patterns
    if (isPlatformTable(table_name)) continue;
    if (excludePatterns.some((p) => table_name.includes(p))) continue;

    // Get the table columns
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

    // Build the fields array in Zveltio format
    const fields = colsResult.rows.map((col) => ({
      name: col.column_name,
      type: mapPgType(col.data_type),
      required: col.is_nullable === 'NO' && col.column_default === null,
      unique: false,
      indexed: false,
      label: col.column_name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    }));

    // If dry-run, collect only the preview
    if (dryRun) {
      results.push({
        tableName: table_name,
        collectionName: table_name,
        fieldsCount: fields.length,
        isNew: true,
      });
      continue;
    }

    // Upsert into zvd_collections
    // `.catch(() => null)` meant "no such collection", and the branch below turns
    // that into an INSERT. So a failed read made introspection try to CREATE a
    // collection row that already existed — a unique-violation at best, a duplicate
    // registration at worst, on a path whose whole job is to reconcile what is
    // already there.
    const existing = await db
      .selectFrom('zvd_collections')
      .select('id')
      .where('name', '=', table_name)
      .executeTakeFirst();

    if (existing) {
      // Update fields but DON'T change is_managed — it may have been already managed
      await db
        .updateTable('zvd_collections')
        .set({ fields: toJsonb(fields), updated_at: new Date() })
        .where('name', '=', table_name)
        .execute();
      results.push({
        tableName: table_name,
        collectionName: table_name,
        fieldsCount: fields.length,
        isNew: false,
      });
    } else {
      const displayName = table_name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

      await db
        .insertInto('zvd_collections')
        .values({
          name: table_name,
          display_name: displayName,
          fields: toJsonb(fields),
          is_managed: false,
          source_type: 'table',
        })
        .execute();
      results.push({
        tableName: table_name,
        collectionName: table_name,
        fieldsCount: fields.length,
        isNew: true,
      });
    }
  }

  return results;
}
