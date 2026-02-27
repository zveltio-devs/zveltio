// All CRUD operations on user-created collections go through this module.
// NEVER use Kysely typed queries for dynamic tables — TypeScript cannot know
// user-defined schemas at compile time.
//
// All identifiers (table names, column names) are sanitized before use to
// prevent SQL injection via Kysely's sql.identifier() which handles quoting.

import { sql } from 'kysely';
import type { Database } from './index.js';

// ─── Identifier sanitization ──────────────────────────────────────────────────

function sanitizeIdentifier(name: string): string {
  const clean = name.replace(/[^a-z0-9_]/gi, '');
  if (!clean) throw new Error(`Invalid SQL identifier: "${name}"`);
  if (clean.length > 63) throw new Error(`SQL identifier too long (max 63): "${name}"`);
  return clean;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type FilterOp =
  | 'eq' | 'neq'
  | 'lt' | 'lte' | 'gt' | 'gte'
  | 'like' | 'ilike'
  | 'in' | 'not_in'
  | 'null' | 'not_null';

export interface FilterCondition {
  op: FilterOp;
  value?: any;
}

export interface QueryOptions {
  filters?: Record<string, FilterCondition>;
  sort?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  records: Record<string, any>[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function buildCondition(key: string, condition: FilterCondition): any {
  const col = sql.identifier(sanitizeIdentifier(key));
  const { op, value } = condition;

  switch (op) {
    case 'eq':       return sql`${col} = ${value}`;
    case 'neq':      return sql`${col} != ${value}`;
    case 'lt':       return sql`${col} < ${value}`;
    case 'lte':      return sql`${col} <= ${value}`;
    case 'gt':       return sql`${col} > ${value}`;
    case 'gte':      return sql`${col} >= ${value}`;
    case 'like':     return sql`${col} LIKE ${'%' + String(value) + '%'}`;
    case 'ilike':    return sql`${col} ILIKE ${'%' + String(value) + '%'}`;
    case 'in':       return sql`${col} = ANY(${value})`;
    case 'not_in':   return sql`NOT (${col} = ANY(${value}))`;
    case 'null':     return sql`${col} IS NULL`;
    case 'not_null': return sql`${col} IS NOT NULL`;
    default:         return sql`${col} = ${value}`;
  }
}

// ─── SELECT ───────────────────────────────────────────────────────────────────

export async function dynamicSelect(
  db: Database,
  tableName: string,
  options: QueryOptions = {},
): Promise<QueryResult> {
  const table = sql.identifier(sanitizeIdentifier(tableName));
  const { limit = 100, offset = 0, filters = {}, sort } = options;

  const conditions = Object.entries(filters).map(([k, v]) => buildCondition(k, v));
  const whereClause = conditions.length > 0
    ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
    : sql``;

  const orderCol = sql.identifier(sanitizeIdentifier(sort?.field ?? 'created_at'));
  const orderDir = sql.raw(sort?.direction === 'asc' ? 'ASC' : 'DESC');
  const orderClause = sql`ORDER BY ${orderCol} ${orderDir}`;

  const [rows, countRow] = await Promise.all([
    sql`
      SELECT * FROM ${table}
      ${whereClause}
      ${orderClause}
      LIMIT ${limit} OFFSET ${offset}
    `.execute(db),
    sql`
      SELECT COUNT(*)::int AS total FROM ${table}
      ${whereClause}
    `.execute(db),
  ]);

  return {
    records: rows.rows as Record<string, any>[],
    total: (countRow.rows[0] as any)?.total ?? 0,
    limit,
    offset,
  };
}

// ─── INSERT ───────────────────────────────────────────────────────────────────

const RESERVED = new Set(['id', 'created_at', 'updated_at']);

export async function dynamicInsert(
  db: Database,
  tableName: string,
  data: Record<string, any>,
): Promise<Record<string, any>> {
  const table = sql.identifier(sanitizeIdentifier(tableName));
  const clean = Object.fromEntries(Object.entries(data).filter(([k]) => !RESERVED.has(k)));

  const cols = Object.keys(clean).map((k) => sql.identifier(sanitizeIdentifier(k)));
  const vals = Object.values(clean).map((v) => sql`${v}`);

  const result = await sql`
    INSERT INTO ${table} (${sql.join(cols, sql`, `)})
    VALUES (${sql.join(vals, sql`, `)})
    RETURNING *
  `.execute(db);

  return result.rows[0] as Record<string, any>;
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

export async function dynamicUpdate(
  db: Database,
  tableName: string,
  id: string,
  data: Record<string, any>,
): Promise<Record<string, any> | null> {
  const table = sql.identifier(sanitizeIdentifier(tableName));
  const clean = Object.fromEntries(Object.entries(data).filter(([k]) => !RESERVED.has(k)));

  if (Object.keys(clean).length === 0) return null;

  const setClauses = Object.entries(clean).map(
    ([k, v]) => sql`${sql.identifier(sanitizeIdentifier(k))} = ${v}`,
  );

  const result = await sql`
    UPDATE ${table}
    SET ${sql.join(setClauses, sql`, `)}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `.execute(db);

  return (result.rows[0] as Record<string, any>) ?? null;
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export async function dynamicDelete(
  db: Database,
  tableName: string,
  id: string,
): Promise<boolean> {
  const table = sql.identifier(sanitizeIdentifier(tableName));

  const result = await sql`
    DELETE FROM ${table} WHERE id = ${id} RETURNING id
  `.execute(db);

  return result.rows.length > 0;
}

// ─── DDL ─────────────────────────────────────────────────────────────────────

export async function dynamicCreateTable(
  db: Database,
  tableName: string,
  columnsDDL: string, // generated by FieldTypeRegistry — trusted input
): Promise<void> {
  const table = sql.identifier(sanitizeIdentifier(tableName));

  await sql`
    CREATE TABLE IF NOT EXISTS ${table} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ${sql.raw(columnsDDL)},
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'published'
    )
  `.execute(db);

  // Standard indexes
  const idxCreated = sql.identifier(`idx_${sanitizeIdentifier(tableName)}_created_at`);
  const idxStatus  = sql.identifier(`idx_${sanitizeIdentifier(tableName)}_status`);

  await sql`CREATE INDEX IF NOT EXISTS ${idxCreated} ON ${table} (created_at DESC)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS ${idxStatus}  ON ${table} (status)`.execute(db);
}

export async function dynamicAddColumn(
  db: Database,
  tableName: string,
  columnDDL: string, // e.g. "col_name TEXT" — generated by FieldTypeRegistry
): Promise<void> {
  const table = sql.identifier(sanitizeIdentifier(tableName));
  await sql`
    ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${sql.raw(columnDDL)}
  `.execute(db);
}

export async function dynamicDropColumn(
  db: Database,
  tableName: string,
  columnName: string,
): Promise<void> {
  const table = sql.identifier(sanitizeIdentifier(tableName));
  const col   = sql.identifier(sanitizeIdentifier(columnName));
  await sql`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${col}`.execute(db);
}
