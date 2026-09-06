// All CRUD operations on user-created collections go through this module.
// NEVER use Kysely typed queries for dynamic tables — TypeScript cannot know
// user-defined schemas at compile time.
//
// All identifiers (table names, column names) are sanitized before use to
// prevent SQL injection via Kysely's sql.id() which handles quoting.

import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';
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
  // Already inside a transaction? Set the timeout on it and carry on.
  //
  // This used to open a transaction unconditionally, and Kysely refuses a nested
  // one — "calling the transaction method for a Transaction is not supported".
  // Three of the five DDL queue handlers hand a transaction handle straight to
  // `DDLManager`, which calls this, so `add_field`, `remove_field` and
  // `drop_collection` threw before emitting a single statement. Reproduced with
  // the engine's own dialect against PostgreSQL 18.
  //
  // Nothing noticed because only `create_collection` is ever enqueued today —
  // the other three paths are wired but unreachable, so the failure waits for
  // whoever first routes a field change through the queue.
  //
  // `SET LOCAL` is transaction-scoped either way, so the caller's transaction
  // gets exactly the timeout it asked for. Same short-circuit as `runAtomic`
  // in `lib/data/write-pipeline.ts`, which was written for this reason.
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) {
    await sql.raw(`SET LOCAL lock_timeout = '${timeout}'`).execute(db);
    await fn(db);
    return;
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

// ─── jsonb binding ────────────────────────────────────────────────────────────

/**
 * Which columns of a dynamic table are `jsonb`, so a value can be bound as the
 * JSON value it is rather than as a string containing it.
 *
 * The driver has one correct form and three plausible wrong ones, all four
 * measured in `lib/jsonb.ts`: a JSON string parameter becomes a jsonb STRING; a
 * raw JS array becomes a Postgres array literal (`[{a:1}]` stored as
 * `{"[object Object]"}`); adding `::jsonb` to an already-encoded parameter
 * changes nothing. Only `::text::jsonb` is right, and it is right for every
 * type.
 *
 * The knowledge lives HERE rather than in the field-type registry because raw
 * callers -- import, sync, internal jobs -- reach `dynamicInsert` without going
 * through `processInput`, and the comment on `RESERVED` below says why that
 * matters: a rule the caller has to remember is a rule that goes missing. The
 * catalogue is the one source that is true for all of them.
 */
const jsonbColumns = new Map<string, Set<string>>();

async function jsonbColumnsFor(db: Database, table: string): Promise<Set<string>> {
  const cached = jsonbColumns.get(table);
  if (cached) return cached;
  const rows = await sql<{ column_name: string }>`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table} AND data_type = 'jsonb'
  `.execute(db);
  const set = new Set(rows.rows.map((r) => r.column_name));
  jsonbColumns.set(table, set);
  return set;
}

/** Forget a table's cached columns. Called when its shape changes. */
export function forgetJsonbColumns(table?: string): void {
  if (table) jsonbColumns.delete(table);
  else jsonbColumns.clear();
}

/**
 * Bind one value for `column`. A jsonb column gets the `::text::jsonb` form; a
 * value that is already a `sql` fragment is passed through untouched, so a
 * caller that has done its own binding is not double-encoded.
 */
function bindValue(value: unknown, column: string, jsonb: Set<string>): RawBuilder<unknown> {
  if (value !== null && typeof value === 'object' && 'isRawBuilder' in (value as object)) {
    return value as RawBuilder<unknown>;
  }
  if (!jsonb.has(column)) return sql`${value}`;
  // `undefined` is not JSON; `null` is, and must stay a jsonb null.
  return sql`${JSON.stringify(value ?? null)}::text::jsonb`;
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
   * Set from `zvd_collections.has_trgm`, which the DDL manager sets on every
   * collection created since pg_trgm search landed (`001_initial.sql`, section
   * `from 059_pg_trgm.sql`). Older collections have no `search_text` column, so
   * the flag is the test, not the collection's age.
   */
  hasTrgm?: boolean;
  /**
   * Whether to spend a `count(*)` on the filtered set.
   *
   * `'exact'` is the default and what every caller got before this existed.
   * Measured on a 300 000-row collection with 100 000 rows in the caller's
   * tenant: the count took **10,06 ms** and the page of 25 it accompanied took
   * **1,63 ms** — six sevenths of the request spent counting rows nobody asked
   * for, and it grows with the tenant, not with the page.
   *
   * `'none'` skips it and settles "is there more" the way the cursor path
   * already did: fetch one row past the limit and look. `total` comes back as a
   * sentinel (see `QueryResult`), so a caller that renders a page count keeps
   * working only if it checks for one.
   */
  countMode?: 'exact' | 'none';
  /**
   * A tenant id to add as `tenant_id = <id>`, or omitted to add nothing.
   *
   * PERFORMANCE ONLY. The RLS policy is untouched and still decides what may be
   * seen; this equality can narrow the same set, never widen it. It exists
   * because the policy reads `tenant_id = ANY (…)`, and `= ANY` over an array
   * the planner cannot see at plan time will not drive an ordered index scan —
   * so a paginated list walks `created_at` and discards other tenants' rows at a
   * cost proportional to how many tenants exist. Measured on 300 000 rows with
   * 100 000 in the caller's tenant:
   *
   *     policy alone            1,94 ms, 6 408 rows discarded
   *     policy + this equality  0,08 ms, none — `(tenant_id, created_at DESC)`
   *
   * The caller must pass it ONLY when the request's reach is its own tenant
   * alone (`getSingleTenantId()`). With a hierarchy in play this would hide the
   * ancestors' rows the caller is entitled to.
   */
  tenantScopeId?: string | null;
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

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  applyAlters?: (qb: any) => any;
}

export interface QueryResult {
  records: DynamicRecord[];
  /**
   * Row count for the filtered set, or a sentinel when it was not asked for:
   * `-1` there are more rows after this page, `-2` there are not. Callers that
   * render a total check `>= 0` first.
   */
  total: number;
  limit: number;
  offset: number;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/**
 * One filter condition → SQL. Exported because the cursor-pagination branch in
 * the list handler used to re-implement a SUBSET of this switch — it covered
 * the six comparison operators and silently dropped everything else, including
 * `in` and `not_in`. Those are valid RLS operators, and RLS conditions are
 * merged into the same filter map, so a row policy written with `in` simply
 * stopped applying the moment a caller passed `?cursor=`. A second
 * implementation of an authorization rule is a second place for one to go
 * missing; there is one now.
 */
export function buildCondition(key: string, condition: FilterCondition): RawBuilder<boolean> {
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
      // Fail CLOSED. Falling through to `=` meant an operator this function
      // does not know silently became equality — which turns a restrictive
      // condition into a permissive one, and does so most easily on the
      // untyped path (a policy row read from the database) where it matters
      // most. `FilterOp` covers every case above, so reaching here means the
      // value did not come from the type.
      throw new Error(
        `Unsupported filter operator "${String(op)}" on "${key}". Refusing to ` +
          `build a condition rather than guess one.`,
      );
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
  const {
    limit = 100,
    offset = 0,
    filters = {},
    sort,
    fts,
    hasTrgm,
    applyAlters,
    countMode = 'exact',
    tenantScopeId,
  } = options;
  const skipCount = countMode === 'none';

  // Build both queries with the Kysely builder so extension query alters
  // (S2-03) — supplied via `applyAlters` — can attach .where() clauses
  // uniformly. Raw SQL is used only for the parts Kysely can't express
  // typesafely against a runtime-resolved table: filters (via sql template)
  // and FTS expressions.
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  let qb: any = (db as any).selectFrom(tableNameSanitized).selectAll();
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  let countQb: any = (db as any)
    .selectFrom(tableNameSanitized)
    .select(sql<number>`count(*)::int`.as('total'));

  // The explicit tenant equality, on BOTH queries — a count that saw a different
  // row set than the page would report a total for rows the page never had.
  if (tenantScopeId) {
    qb = qb.where('tenant_id', '=', tenantScopeId);
    countQb = countQb.where('tenant_id', '=', tenantScopeId);
  }

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
      // search_text is maintained by the DDL trigger, and only exists on collections
      // carrying has_trgm — see the field's doc comment above.
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
  // One extra row when the count is skipped — that row IS the "has more" answer.
  qb = qb.limit(skipCount ? limit + 1 : limit).offset(offset);

  if (skipCount) {
    // One row past the page: its presence is the whole "is there more" answer,
    // and it costs one index entry instead of a scan over the tenant's rows.
    const probed = (await qb.execute()) as DynamicRecord[];
    const hasMore = probed.length > limit;
    return {
      records: hasMore ? probed.slice(0, limit) : probed,
      total: hasMore ? -1 : -2,
      limit,
      offset,
    };
  }

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
  // The payload never chooses the tenant. The column DEFAULT reads
  // `current_setting('zveltio.current_tenant')`, so omitting it here means the
  // row is stamped from the transaction rather than from whatever the caller
  // sent. RLS refuses a forged value on the enforcing role — but only there,
  // and a superuser connection writes it happily, so the filter is what makes
  // the guarantee independent of how the database is configured.
  'tenant_id',
]);

/**
 * Trusted values the ENGINE supplies, applied after the filter above.
 *
 * `RESERVED` and authorship were in conflict: the engine set
 * `created_by`/`updated_by` from the session and then handed them to a function
 * whose job was to strip exactly those keys. It stripped them. Every row
 * written through this path had NULL authorship — measured, not inferred — and
 * every RLS policy scoping "own records" by `created_by` matched nothing as a
 * result. The filter was doing what it was told; the two rules were just never
 * read together.
 *
 * Two parameters rather than one merged object, so the distinction is in the
 * signature: `data` is whatever the caller received, `system` is what the
 * engine decided. A `before` hook cannot forge authorship either, because it
 * only ever sees `data`.
 */
export type SystemColumns = Record<string, unknown>;

export async function dynamicInsert(
  db: Database,
  tableName: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  data: Record<string, any>,
  /** Engine-supplied columns — see `SystemColumns`. Applied after the filter. */
  system: SystemColumns = {},
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
): Promise<Record<string, any>> {
  const table = sql.id(sanitizeIdentifier(tableName));
  const clean = {
    ...Object.fromEntries(Object.entries(data).filter(([k]) => !RESERVED.has(k))),
    ...system,
  };

  const jsonb = await jsonbColumnsFor(db, sanitizeIdentifier(tableName));
  const cols = Object.keys(clean).map((k) => sql.id(sanitizeIdentifier(k)));
  const vals = Object.entries(clean).map(([k, v]) => bindValue(v, k, jsonb));

  const result = await sql`
    INSERT INTO ${table} (${sql.join(cols, sql`, `)})
    VALUES (${sql.join(vals, sql`, `)})
    RETURNING *
  `.execute(db);

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  return result.rows[0] as Record<string, any>;
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

export async function dynamicUpdate(
  db: Database,
  tableName: string,
  id: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  data: Record<string, any>,
  /**
   * Engine-supplied columns — see `SystemColumns`. Applied after the filter.
   *
   * `dynamicInsert` got this and `dynamicUpdate` did not, which left the fix
   * half-made in a way worse than the original bug. Before, `updated_by` was
   * NULL: visibly unpopulated, and nobody was misled. After, every row carried
   * the author from its INSERT and never moved, so the column asserted that the
   * creator had last modified a record they may not have touched since. A wrong
   * value that looks right is harder to notice than a missing one.
   */
  system: SystemColumns = {},
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
): Promise<Record<string, any> | null> {
  const table = sql.id(sanitizeIdentifier(tableName));
  const fromCaller = Object.fromEntries(Object.entries(data).filter(([k]) => !RESERVED.has(k)));

  // Emptiness is decided on the CALLER's fields, before `system` is merged.
  // Checking afterwards would make every no-op patch write a row, stamping
  // `updated_by` for a modification nobody made — which is the same class of
  // false record this parameter exists to remove.
  if (Object.keys(fromCaller).length === 0) return null;

  const clean = { ...fromCaller, ...system };

  const jsonb = await jsonbColumnsFor(db, sanitizeIdentifier(tableName));
  const setClauses = Object.entries(clean).map(
    ([k, v]) => sql`${sql.id(sanitizeIdentifier(k))} = ${bindValue(v, k, jsonb)}`,
  );

  const result = await sql`
    UPDATE ${table}
    SET ${sql.join(setClauses, sql`, `)}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `.execute(db);

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
  // The column set changed; the cached jsonb list for this table is stale.
  forgetJsonbColumns(sanitizeIdentifier(tableName));
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
  // The column set changed; the cached jsonb list for this table is stale.
  forgetJsonbColumns(sanitizeIdentifier(tableName));
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
  // The column set changed; the cached jsonb list for this table is stale.
  forgetJsonbColumns(sanitizeIdentifier(tableName));
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
  // The column set changed; the cached jsonb list for this table is stale.
  forgetJsonbColumns(sanitizeIdentifier(tableName));
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
