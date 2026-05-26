// All CRUD operations on user-created collections go through this module.
// NEVER use Kysely typed queries for dynamic tables — TypeScript cannot know
// user-defined schemas at compile time.
//
// All identifiers (table names, column names) are sanitized before use to
// prevent SQL injection via Kysely's sql.id() which handles quoting.

import { sql } from 'kysely';
import type { Database } from './index.js';
import type { DynamicRecord } from './dynamic-types.js';

// ─── Safe DDL helpers ─────────────────────────────────────────────────────────

/**
 * Execute DDL that requires lock (ALTER TABLE / DROP COLUMN) with a strict timeout.
 * SET LOCAL guarantees that the timeout resets automatically at the end of the transaction
 * — the connection from the pool returns clean after COMMIT/ROLLBACK.
 */
async function withLockTimeout(
  db: Database,
  fn: (trx: Database) => Promise<void>,
  timeout = '2s',
): Promise<void> {
  // Format validation: allows only digits + unit (ms/s/min) — prevents SQL injection
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

// ─── Identifier sanitization ──────────────────────────────────────────────────

function sanitizeIdentifier(name: string): string {
  // Throw on invalid chars instead of silently stripping. Silent stripping
  // could map "id'--" → "id--" producing a valid-but-wrong identifier and
  // either a confusing "column not found" error or, worse, aliasing a
  // different column entirely.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid SQL identifier "${name}" — only letters, digits, and underscores allowed, must start with a letter or underscore.`,
    );
  }
  if (name.length > 63) throw new Error(`SQL identifier too long (max 63): "${name}"`);
  return name;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'like'
  | 'ilike'
  | 'in'
  | 'not_in'
  | 'null'
  | 'not_null';

export interface FilterCondition {
  op: FilterOp;
  value?: any;
}

export interface QueryOptions {
  filters?: Record<string, FilterCondition>;
  sort?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  /** Full-text search term — applied as search_vector @@ websearch_to_tsquery() */
  fts?: string;
  /**
   * When true, extends FTS with pg_trgm similarity on search_text column.
   * Only set for collections created after migration 059 (has_trgm = true in zvd_collections).
   */
  hasTrgm?: boolean;
  /**
   * Optional hook to mutate the Kysely query builder before execution.
   * Used by routes/data.ts to apply extension `queryAlter` filters (S2-03)
   * so global concerns (tenant isolation, soft-delete masks, redaction)
   * affect the list endpoint just like single-record GETs.
   *
   * The callback receives the in-flight Kysely builder and must return it
   * (typically chained `.where()` calls). It's applied to both the rows
   * query and the count query so totals stay consistent with results.
   */
  applyAlters?: (qb: any) => any;
}

export interface QueryResult {
  records: DynamicRecord[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function buildCondition(key: string, condition: FilterCondition): any {
  const col = sql.id(sanitizeIdentifier(key));
  const { op, value } = condition;

  switch (op) {
    case 'eq':
      return sql`${col} = ${value}`;
    case 'neq':
      return sql`${col} != ${value}`;
    case 'lt':
      return sql`${col} < ${value}`;
    case 'lte':
      return sql`${col} <= ${value}`;
    case 'gt':
      return sql`${col} > ${value}`;
    case 'gte':
      return sql`${col} >= ${value}`;
    case 'like':
      return sql`${col} LIKE ${'%' + String(value) + '%'}`;
    case 'ilike':
      return sql`${col} ILIKE ${'%' + String(value) + '%'}`;
    case 'in':
      return sql`${col} = ANY(${value})`;
    case 'not_in':
      return sql`NOT (${col} = ANY(${value}))`;
    case 'null':
      return sql`${col} IS NULL`;
    case 'not_null':
      return sql`${col} IS NOT NULL`;
    default:
      return sql`${col} = ${value}`;
  }
}

// ─── SELECT ───────────────────────────────────────────────────────────────────

export async function dynamicSelect(
  db: Database,
  tableName: string,
  options: QueryOptions = {},
): Promise<QueryResult> {
  // sanitizeIdentifier validates the name; Kysely will quote it on emission.
  const tableNameSanitized = sanitizeIdentifier(tableName);
  const { limit = 100, offset = 0, filters = {}, sort, fts, hasTrgm, applyAlters } = options;

  // Build both queries with the Kysely builder so extension query alters
  // (S2-03) — supplied via `applyAlters` — can attach .where() clauses
  // uniformly. Raw SQL is used only for the parts Kysely can't express
  // typesafely against a runtime-resolved table: filters (via sql template)
  // and FTS expressions.
  let qb: any = (db as any).selectFrom(tableNameSanitized).selectAll();
  let countQb: any = (db as any)
    .selectFrom(tableNameSanitized)
    .select(sql<number>`count(*)::int`.as('total'));

  // Filters — reuse buildCondition which already escapes identifiers + binds
  // values. Kysely's .where() accepts a raw sql expression as a guard.
  for (const [field, cond] of Object.entries(filters)) {
    const expr = buildCondition(field, cond);
    qb = qb.where(expr);
    countQb = countQb.where(expr);
  }

  if (fts) {
    let ftsExpr;
    if (hasTrgm) {
      // Combined: FTS via tsvector OR trgm similarity on search_text (fuzzy/prefix matching).
      // search_text is maintained by the DDL trigger for collections created after migration 059.
      const likePattern = `%${fts.replace(/%/g, '').replace(/_/g, '')}%`;
      ftsExpr = sql`(search_vector @@ websearch_to_tsquery('english', ${fts}) OR search_text ILIKE ${likePattern})`;
    } else {
      // websearch_to_tsquery() tolerates arbitrary user input without syntax errors
      ftsExpr = sql`search_vector @@ websearch_to_tsquery('english', ${fts})`;
    }
    qb = qb.where(ftsExpr);
    countQb = countQb.where(ftsExpr);
  }

  // Extension query alters — must run on BOTH queries so the count reflects
  // the same row set that's returned. Without this, an extension that
  // filters out half the rows would report a misleading total.
  if (applyAlters) {
    qb = applyAlters(qb);
    countQb = applyAlters(countQb);
  }

  // Sort + pagination apply only to the rows query.
  const sortField = sanitizeIdentifier(sort?.field ?? 'created_at');
  qb = qb.orderBy(sortField, sort?.direction === 'asc' ? 'asc' : 'desc');
  qb = qb.limit(limit).offset(offset);

  const [rows, countRow] = await Promise.all([
    qb.execute() as Promise<DynamicRecord[]>,
    countQb.executeTakeFirst() as Promise<{ total: number } | undefined>,
  ]);

  return {
    records: rows,
    total: Number(countRow?.total ?? 0),
    limit,
    offset,
  };
}

// ─── INSERT ───────────────────────────────────────────────────────────────────

// System columns never accepted from user input:
//   id / created_at / updated_at — managed by the table defaults and triggers.
//   status                        — set via dedicated lifecycle endpoints.
//   created_by / updated_by       — set from the authenticated session.
//   search_vector                 — computed by per-table FTS trigger.
// Filtering these here is defence-in-depth; processInput() normally strips
// them first but raw callers (internal jobs) may not.
const RESERVED = new Set([
  'id',
  'created_at',
  'updated_at',
  'status',
  'created_by',
  'updated_by',
  'search_vector',
]);

export async function dynamicInsert(
  db: Database,
  tableName: string,
  data: Record<string, any>,
): Promise<Record<string, any>> {
  const table = sql.id(sanitizeIdentifier(tableName));
  const clean = Object.fromEntries(Object.entries(data).filter(([k]) => !RESERVED.has(k)));

  const cols = Object.keys(clean).map((k) => sql.id(sanitizeIdentifier(k)));
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
  const table = sql.id(sanitizeIdentifier(tableName));
  const clean = Object.fromEntries(Object.entries(data).filter(([k]) => !RESERVED.has(k)));

  if (Object.keys(clean).length === 0) return null;

  const setClauses = Object.entries(clean).map(
    ([k, v]) => sql`${sql.id(sanitizeIdentifier(k))} = ${v}`,
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

export async function dynamicDelete(db: Database, tableName: string, id: string): Promise<boolean> {
  const table = sql.id(sanitizeIdentifier(tableName));

  const result = await sql`
    DELETE FROM ${table} WHERE id = ${id} RETURNING id
  `.execute(db);

  return result.rows.length > 0;
}

// ─── DDL ─────────────────────────────────────────────────────────────────────
// Table creation lives in DDLManager.createCollection(). Keeping a parallel
// path here (earlier: dynamicCreateTable) led to divergent schemas — e.g.
// status DEFAULT 'published' vs 'active', missing search_vector and
// created_by/updated_by. DDLManager is the single source of truth.

export async function dynamicAddColumn(
  db: Database,
  tableName: string,
  columnDDL: string, // e.g. "col_name TEXT" — generated by FieldTypeRegistry
): Promise<void> {
  const table = sql.id(sanitizeIdentifier(tableName));
  // ALTER TABLE ia AccessExclusiveLock → lock_timeout previne blocarea query-urilor active
  await withLockTimeout(db, async (trx) => {
    await sql`
      ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${sql.raw(columnDDL)}
    `.execute(trx);
  });
}

export async function dynamicDropColumn(
  db: Database,
  tableName: string,
  columnName: string,
): Promise<void> {
  const table = sql.id(sanitizeIdentifier(tableName));
  const col = sql.id(sanitizeIdentifier(columnName));
  // ALTER TABLE DROP COLUMN ia AccessExclusiveLock → lock_timeout strict
  await withLockTimeout(db, async (trx) => {
    await sql`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${col}`.execute(trx);
  });
}

export async function dynamicRenameColumn(
  db: Database,
  tableName: string,
  fromColumn: string,
  toColumn: string,
): Promise<void> {
  const table = sql.id(sanitizeIdentifier(tableName));
  const from = sql.id(sanitizeIdentifier(fromColumn));
  const to = sql.id(sanitizeIdentifier(toColumn));
  // RENAME COLUMN takes AccessExclusiveLock briefly — same lock_timeout
  // guard as add/drop so an in-flight query doesn't starve the rename.
  await withLockTimeout(db, async (trx) => {
    await sql`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`.execute(trx);
  });
}

/**
 * ALTER COLUMN ... TYPE with a USING expression that the caller supplies.
 *
 * The USING clause is REQUIRED for any conversion Postgres can't do via
 * implicit cast (e.g. text → integer). The caller picks the expression
 * based on the source/destination types — see field-type-conversions.ts.
 *
 * sqlType MUST be a vetted DDL fragment, NOT user input — we don't escape
 * the type name because Postgres types have their own syntax (e.g.
 * `numeric(10,2)`, `varchar(255)`). The route layer is responsible for
 * resolving the type via fieldTypeRegistry which only emits safe DDL.
 */
export async function dynamicChangeColumnType(
  db: Database,
  tableName: string,
  columnName: string,
  sqlType: string,
  usingExpression?: string,
): Promise<void> {
  const table = sql.id(sanitizeIdentifier(tableName));
  const col = sql.id(sanitizeIdentifier(columnName));
  const usingClause = usingExpression ? sql.raw(`USING ${usingExpression}`) : sql.raw('');
  await withLockTimeout(db, async (trx) => {
    await sql`
      ALTER TABLE ${table}
      ALTER COLUMN ${col} TYPE ${sql.raw(sqlType)} ${usingClause}
    `.execute(trx);
  });
}

/** Toggle NOT NULL on a column. Used for the `required` flag. */
export async function dynamicSetColumnRequired(
  db: Database,
  tableName: string,
  columnName: string,
  required: boolean,
): Promise<void> {
  const table = sql.id(sanitizeIdentifier(tableName));
  const col = sql.id(sanitizeIdentifier(columnName));
  await withLockTimeout(db, async (trx) => {
    if (required) {
      await sql`ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`.execute(trx);
    } else {
      await sql`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`.execute(trx);
    }
  });
}
