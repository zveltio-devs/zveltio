/**
 * GET /:collection/aggregate (ADR 0050): count, sum, avg, min and max, grouped,
 * under exactly the read gate of a list.
 *
 * Same permission check, same `readScope`, same tenant transaction, same source
 * (the `zvv_*` masking view when there is one): row rules and query alters run
 * as SQL before the aggregation, so `count` is the list's `total` for the same
 * filter. A field the caller may not filter a list by — hidden, sealed,
 * `encrypted`, `secret`, unserved — answers the 400 a field that does not exist
 * gets. What has no SQL form (entity access, a virtual collection, `as_of`) is
 * refused, never approximated by reading rows into the engine.
 */

import type { Context } from 'hono';
import { type RawBuilder, sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/index.js';
import { sqlState } from '../../../db/bun-sql-quirks.js';
import { buildCondition, ftsCondition, readSource } from '../../../db/dynamic.js';
import { withSavepoint } from '../../savepoint.js';
import { tenantId } from '../../route-db.js';
import { effectiveTimeZone } from '../../tenancy/timezone.js';
import { getSingleTenantId } from '../../tenancy/index.js';
import { DDLManager } from '../ddl-manager.js';
import { readScope } from '../read-scope.js';
import { buildAllowedCols, buildLocationCols, parseFilters } from '../query-parse.js';
import {
  normalizeFields,
  NUMERIC_FIELD_TYPES,
  serializeRecord,
  withheldColumns,
} from '../shape.js';
import { dynamicDb, getVirtualConfig } from '../write-pipeline.js';
import { checkAccess } from '../auth.js';
import type { CollectionDef } from '../types.js';
import { searchColumns } from './list.js';

export const AggregateQuerySchema = z.object({
  fn: z.string().min(1),
  group_by: z.string().optional(),
  bucket: z.string().optional(),
  filter: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  as_of: z.string().optional(),
});
export type AggregateQuery = z.infer<typeof AggregateQuerySchema>;

/** Fixed, like ADR 0021's 10 rounds: no setting (ADR 0050 decision 6). */
export const AGGREGATE_TIMEOUT = '5s';
const MAX_FNS = 8;
const MAX_GROUPS = 3;

const FN_RE = /^(count|sum|avg|min|max)(?::([A-Za-z_][A-Za-z0-9_]*))?$/;
const UNITS = new Set(['day', 'week', 'month', 'year']);
const DATE_TYPES = new Set(['date', 'datetime']);
/** Not a scalar: no grouping on a document, a point, a file or a list. */
const UNGROUPABLE = new Set([
  'json',
  'file',
  'image',
  'location',
  'geometry',
  'vector',
  'tags',
  'bytea',
  'tsvector',
  'xml',
]);
const SYSTEM_TYPES: Record<string, string> = {
  id: 'uuid',
  created_at: 'datetime',
  updated_at: 'datetime',
  created_by: 'text',
  updated_by: 'text',
};

const AGGREGATES: Record<string, (arg: RawBuilder<unknown>) => RawBuilder<unknown>> = {
  count: (a) => sql`count(${a})`,
  sum: (a) => sql`sum(${a})`,
  avg: (a) => sql`avg(${a})`,
  min: (a) => sql`min(${a})`,
  max: (a) => sql`max(${a})`,
};

const TOO_COSTLY = Symbol('aggregate_too_costly');

/**
 * `run` under `statement_timeout = 5s`, in a savepoint on the request
 * transaction, with the setting put back after it. A timeout (57014) is undone
 * by the savepoint, so the request transaction stays usable for the 422.
 */
export function underCeiling<T>(
  trx: Database,
  run: () => Promise<T>,
): Promise<T | typeof TOO_COSTLY> {
  return withSavepoint<T | typeof TOO_COSTLY>(
    trx,
    'zv_aggregate',
    async () => {
      const prev = await sql<{
        t: string;
      }>`SELECT current_setting('statement_timeout') AS t`.execute(trx);
      await sql`SELECT set_config('statement_timeout', ${AGGREGATE_TIMEOUT}, true)`.execute(trx);
      const out = await run();
      await sql`SELECT set_config('statement_timeout', ${prev.rows[0]!.t}, true)`.execute(trx);
      return out;
    },
    (err) => {
      if (sqlState(err) === '57014') return TOO_COSTLY;
      throw err;
    },
  );
}

const bad = (c: Context, error: string) => c.json({ error }, 400);

export async function aggregateRecords(c: Context, query: AggregateQuery): Promise<Response> {
  const collection = c.req.param('collection')!;
  const user = c.get('user');
  const trx = c.get('tenantTrx') as Database | null;
  // The ceiling is a SET LOCAL: without the request's transaction it binds nothing.
  if (!trx) return c.json({ error: 'Tenant not found' }, 404);

  if (!(await checkAccess(trx, user, collection, 'read'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (query.as_of) return bad(c, 'Aggregates do not support as_of');
  if (await getVirtualConfig(trx, collection)) {
    return bad(c, 'Aggregates are not available on a virtual collection');
  }
  const def = (await DDLManager.getCollection(trx, collection)) as CollectionDef | null;
  if (!def) return c.json({ error: 'Collection not found' }, 404);

  const scope = await readScope(trx, collection, user, c.get('authType'));
  // A JS callback per row has no SQL form (ADR 0050 decision 4).
  if (scope.entityChecks) {
    return c.json(
      {
        error: 'aggregate_unavailable: an extension judges this collection row by row',
        code: 'aggregate_unavailable',
      },
      403,
    );
  }

  // What a list may filter by, minus what REST serves only transformed.
  const { sealed } = withheldColumns(def);
  const allowed = new Set(
    [...buildAllowedCols(def)].filter((f) => scope.readable(f) && !sealed.includes(f)),
  );
  const types = new Map<string, string>(Object.entries(SYSTEM_TYPES));
  for (const f of normalizeFields(def)) types.set(f.name, f.type);
  const typeOf = (f: string) => types.get(f) ?? '';

  // ── fn ──
  const fns = query.fn.split(',').map((s) => s.trim());
  if (fns.length > MAX_FNS) return bad(c, `At most ${MAX_FNS} aggregate functions`);
  if (new Set(fns).size !== fns.length) return bad(c, 'Duplicate aggregate function');
  const values: RawBuilder<unknown>[] = [];
  const valueField: (string | undefined)[] = [];
  for (const spec of fns) {
    const m = FN_RE.exec(spec);
    if (!m || (m[1] !== 'count' && !m[2])) return bad(c, `Unknown aggregate function: '${spec}'`);
    const [, fn, field] = m as unknown as [string, string, string | undefined];
    if (field !== undefined && !allowed.has(field)) return bad(c, `Unknown field: '${field}'`);
    const t = field ? typeOf(field) : '';
    if ((fn === 'sum' || fn === 'avg') && !NUMERIC_FIELD_TYPES.has(t)) {
      return bad(c, `Cannot ${fn} '${field}': not a numeric field`);
    }
    if ((fn === 'min' || fn === 'max') && !NUMERIC_FIELD_TYPES.has(t) && !DATE_TYPES.has(t)) {
      return bad(c, `Cannot ${fn} '${field}': not a numeric, date or datetime field`);
    }
    values.push(AGGREGATES[fn]!(field ? sql.ref(field) : sql`*`));
    valueField.push(fn === 'count' ? undefined : field);
  }

  // ── group_by + bucket ──
  const groupBy = query.group_by ? query.group_by.split(',').map((s) => s.trim()) : [];
  if (groupBy.length > MAX_GROUPS) return bad(c, `At most ${MAX_GROUPS} group_by fields`);
  if (new Set(groupBy).size !== groupBy.length) return bad(c, 'Duplicate group_by field');
  for (const f of groupBy) {
    if (!allowed.has(f)) return bad(c, `Unknown field: '${f}'`);
    if (UNGROUPABLE.has(typeOf(f))) return bad(c, `Cannot group by '${f}': not a scalar field`);
  }
  const buckets = new Map<string, string>();
  for (const spec of query.bucket ? query.bucket.split(',').map((s) => s.trim()) : []) {
    const [field = '', unit = '', ...rest] = spec.split(':');
    if (!allowed.has(field)) return bad(c, `Unknown field: '${field}'`);
    if (rest.length > 0 || !UNITS.has(unit)) return bad(c, `Unknown bucket: '${spec}'`);
    if (!DATE_TYPES.has(typeOf(field))) {
      return bad(c, `Cannot bucket '${field}': not a date or datetime field`);
    }
    if (!groupBy.includes(field) || buckets.has(field)) {
      return bad(c, `Bucket '${spec}' must name a group_by field once`);
    }
    buckets.set(field, unit);
  }
  const zone = [...buckets.keys()].some((f) => typeOf(f) === 'datetime')
    ? await effectiveTimeZone(trx, tenantId(c))
    : 'UTC';
  const keys = groupBy.map((f) => {
    const unit = buckets.get(f);
    if (!unit) return sql.ref(f);
    // A date is a calendar day already; a datetime is cut in the tenant's zone.
    return typeOf(f) === 'date'
      ? sql`date_trunc(${unit}, ${sql.ref(f)}::timestamp)::date`
      : sql`date_trunc(${unit}, ${sql.ref(f)}, ${zone})`;
  });

  // ── filter + search: the list's parser, over the same field set ──
  const parsed = parseFilters(c.req.query(), query.filter, allowed, buildLocationCols(def));
  if (!parsed.ok) return bad(c, parsed.error);
  const search = query.search ? query.search.trim().substring(0, 500) : undefined;

  const table = DDLManager.getTableName(collection);
  const { from, version } = await readSource(trx, table);
  let qb = dynamicDb(trx).selectFrom(from).modifyEnd(version);
  // Performance only, as on the list: RLS still decides (`dynamicSelect`).
  const single = getSingleTenantId();
  if (single) qb = qb.where('tenant_id', '=', single);
  for (const [field, conds] of Object.entries(parsed.filters)) {
    for (const cond of [conds].flat()) qb = qb.where(buildCondition(field, cond));
  }
  if (search) {
    qb = qb.where(ftsCondition(search, !!def.has_trgm, searchColumns(def, scope.readable)));
  }
  qb = scope.query(qb);
  qb = qb.select([...keys.map((k, i) => k.as(`g${i}`)), ...values.map((v, i) => v.as(`v${i}`))]);
  if (keys.length > 0) {
    // By position: an alias can collide with a field of the same name.
    const at = keys.map((_, i) => sql.lit(i + 1));
    qb = qb.groupBy(at);
    for (const k of at) qb = qb.orderBy(k);
    qb = qb.limit(query.limit + 1);
  }

  const rows = await underCeiling(trx, () => qb.execute() as Promise<Record<string, unknown>[]>);
  if (rows === TOO_COSTLY) {
    return c.json(
      { error: 'aggregate_too_costly: narrow the filter', code: 'aggregate_too_costly' },
      422,
    );
  }

  // Each value as a list serves its field: `decimal` coerced, a date as a date.
  const serve = async (field: string | undefined, v: unknown) => {
    if (v === null || v === undefined) return null;
    if (!field) return Number(v);
    return (await serializeRecord({ [field]: v }, def, scope.columns))[field] ?? null;
  };
  const data = await Promise.all(
    rows.slice(0, query.limit).map(async (r) => {
      const group: Record<string, unknown> = {};
      for (const [i, f] of groupBy.entries()) group[f] = await serve(f, r[`g${i}`]);
      const out: Record<string, unknown> = {};
      for (const [i, spec] of fns.entries()) out[spec] = await serve(valueField[i], r[`v${i}`]);
      return { group, values: out };
    }),
  );
  return c.json({ data, truncated: rows.length > query.limit });
}
