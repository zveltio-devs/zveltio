/**
 * Request-parameter parsing for the CRUD list endpoint (H-05 split of
 * `routes/data.ts`).
 *
 * Turns raw query params into a typed, validated `ParsedQuery` plus the
 * filter/sort/cursor primitives the list handler feeds to `dynamicSelect`.
 * Pure functions — no DB, no Hono — so they are unit-testable and the route
 * handler stays thin. Every operator alias, coercion rule, precedence order
 * and error string is byte-identical to the pre-split inline code.
 */

import { z } from 'zod';
import { type FilterCondition, toBox, toNear } from '../../db/dynamic.js';
import { fieldTypeRegistry } from './field-type-registry.js';
import { normalizeFields } from './shape.js';
import type { CollectionDef, JsonValue } from './types.js';

/** Zod schema for the list endpoint's query string. */
export const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  filter: z.string().optional(),
  search: z.string().optional(),
  as_of: z.string().optional(),
  cursor: z.string().optional(), // base64url-encoded {id, val}
  /**
   * `exact` (default) keeps `pagination.total`; `none` drops it.
   *
   * The count is a `count(*)` over the caller's whole tenant, and on a 100 000-row
   * tenant it measured 10,06 ms next to a 1,63 ms page — so a client that renders
   * "page 3 of 40" pays for it and one that renders "load more" pays for it too.
   * `none` answers "is there more" from one extra row instead, which is what the
   * cursor path has always done. Default unchanged, so no existing caller moves.
   */
  count: z.enum(['exact', 'none']).default('exact'),
});

/** The parsed, validated list query. */
export type ParsedQuery = z.infer<typeof QuerySchema>;

/** System columns always allowed for sort/filter, regardless of schema. */
const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at', 'created_by', 'updated_by']);

/** Map client-facing filter operator names to the canonical `FilterCondition` op. */
const OP_ALIAS: Record<string, FilterCondition['op']> = {
  eq: 'eq',
  neq: 'neq',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  like: 'ilike',
  contains: 'ilike',
  ilike: 'ilike',
  not_contains: 'not_contains',
  starts_with: 'starts_with',
  ends_with: 'ends_with',
  in: 'in',
  not_in: 'not_in',
  null: 'null',
  is_null: 'null',
  not_null: 'not_null',
  is_not_null: 'not_null',
  near: 'near',
  within: 'within',
};

/** The canonical op for a client-facing name, or undefined. Own keys only: a
 * plain lookup also answered `constructor`, `toString` or `__proto__` with what
 * the object inherits, and that function became the filter's operator — a 500
 * from `buildCondition` on `?title[constructor]=x` instead of a skipped filter. */
function mapOp(op: string): FilterCondition['op'] | undefined {
  return Object.hasOwn(OP_ALIAS, op) ? OP_ALIAS[op] : undefined;
}

const MALFORMED_FILTER = "Malformed filter: 'filter' must be a JSON object";
const unknownOp = (field: string, op: string): ParseFiltersResult => ({
  ok: false,
  error: `Unknown filter operator: '${op}' on '${field}'`,
});

/** The operators a `location` column answers, and the only place `near` and
 * `within` apply: comparing a point with `=` or `LIKE` is a 500. */
const GEO_OPS = new Set<FilterCondition['op']>(['near', 'within']);
const LOCATION_OPS = new Set<FilterCondition['op']>(['near', 'within', 'null', 'not_null']);

/** `near`/`within` from the bracket string (`lat,lng,radius`,
 * `minLat,minLng,maxLat,maxLng`) or the JSON object, checked; null if bad. */
function geoValue(op: FilterCondition['op'], raw: unknown): unknown {
  if (typeof raw === 'string') {
    const n = raw.split(',').map((p) => (p.trim() === '' ? Number.NaN : Number(p)));
    raw =
      op === 'near'
        ? n.length === 3 && { lat: n[0], lng: n[1], radius: n[2] }
        : n.length === 4 && { minLat: n[0], minLng: n[1], maxLat: n[2], maxLng: n[3] };
  }
  return op === 'near' ? toNear(raw) : toBox(raw);
}

const GEO_FORMAT: Record<string, string> = {
  near: '{"lat","lng","radius"} (metres) or lat,lng,radius',
  within:
    '{"minLat","minLng","maxLat","maxLng"} or minLat,minLng,maxLat,maxLng, not crossing the antimeridian',
};

/** The `location` columns of a collection: the ones `near`/`within` apply to. */
export function buildLocationCols(collectionDef: CollectionDef | null | undefined): Set<string> {
  return new Set(
    normalizeFields(collectionDef)
      .filter((f) => f.name && f.type === 'location')
      .map((f) => f.name),
  );
}

const BRACKET_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_]+)\]$/;
const NUMERIC_OPS = new Set<FilterCondition['op']>(['gt', 'gte', 'lt', 'lte']);

/** Build the set of columns clients are allowed to sort/filter by. Hitting
 * Postgres with an unknown column surfaces as a 500 ("column X does not
 * exist") — the caller uses this to return a clean 400 at the edge instead.
 * A field type declaring no filter operators (`password`, `computed`) is left
 * out: a predicate or an order on it reads it back through the row count. */
export function buildAllowedCols(collectionDef: CollectionDef | null | undefined): Set<string> {
  const rawFields = normalizeFields(collectionDef).filter(
    (f) => f.name && fieldTypeRegistry.get(f.type)?.api.filterOperators?.length !== 0,
  );
  return new Set<string>([...SYSTEM_COLS, ...rawFields.map((f) => f.name)]);
}

/** Result of `parseFilters`: either the parsed filter map, or a 400 error to
 * surface (unknown filter field). */
export type ParseFiltersResult =
  | { ok: true; filters: Record<string, FilterCondition | FilterCondition[]> }
  | { ok: false; error: string };

/** Parse filters from the two supported formats (both can be used together):
 *
 *  1. JSON:    ?filter={"price":{"gt":50},"title":{"like":"pro"}}
 *  2. Bracket: ?price[gt]=50&title[like]=pro  (simpler for curl/browser)
 *
 * Several operators on one field (`?price[gt]=1&price[lt]=9`,
 * `{"price":{"gt":1,"lt":9}}`) are ANDed; the field then maps to an array.
 *
 * When both are provided for the same field, JSON takes precedence. A filter
 * this function cannot apply — an unknown field or operator in either format,
 * or a `filter` that is not a JSON object — is a 400 (returned via `error`),
 * never skipped: a skipped filter answered with every row the caller may read,
 * as if it had matched (ADR 0019 decision 6). An empty operator object
 * (`{field: {}}`) asks for no condition and adds none. */
export function parseFilters(
  queryParams: Record<string, string>,
  filterJson: string | undefined,
  allowedCols: Set<string>,
  locationCols: Set<string> = new Set(),
): ParseFiltersResult {
  const filters: Record<string, FilterCondition | FilterCondition[]> = {};
  const add = (field: string, cond: FilterCondition) => {
    const prev = filters[field];
    filters[field] = prev ? [prev, cond].flat() : cond;
  };
  /** A geo operator on a non-`location` field, a non-geo one on a `location`
   * field, or a malformed geo value: the error, else null. */
  const geoError = (field: string, op: string, mapped: FilterCondition['op'], value: unknown) => {
    if (locationCols.has(field) ? !LOCATION_OPS.has(mapped) : GEO_OPS.has(mapped)) {
      return `Filter operator '${op}' does not apply to '${field}'`;
    }
    if (GEO_OPS.has(mapped) && value === null) {
      return `Malformed '${op}' on '${field}': ${GEO_FORMAT[mapped]}`;
    }
    return null;
  };

  // Format 2: bracket syntax — parse before JSON so JSON can override
  for (const [paramKey, paramVal] of Object.entries(queryParams)) {
    const m = BRACKET_RE.exec(paramKey);
    if (!m) {
      // `my-field[near]`, `a[b][c]`: shaped like a filter but unparseable.
      if (paramKey.includes('['))
        return { ok: false, error: `Malformed filter key: '${paramKey}'` };
      continue;
    }
    const [, field, op] = m;
    if (!allowedCols.has(field)) return { ok: false, error: `Unknown filter field: '${field}'` };
    const mappedOp = mapOp(op);
    if (!mappedOp) return unknownOp(field, op);
    // Coerce numeric-looking values to numbers for comparison operators
    // A query string has no arrays, so `tag[in]=a,b` is the list a,b.
    const value = GEO_OPS.has(mappedOp)
      ? geoValue(mappedOp, paramVal)
      : mappedOp === 'in' || mappedOp === 'not_in'
        ? paramVal.split(',')
        : NUMERIC_OPS.has(mappedOp) && paramVal !== '' && !Number.isNaN(Number(paramVal))
          ? Number(paramVal)
          : paramVal;
    const bad = geoError(field, op, mappedOp, value);
    if (bad) return { ok: false, error: bad };
    add(field, { op: mappedOp, value });
  }

  // Format 1: JSON (overrides bracket for same field)
  if (filterJson) {
    let raw: unknown;
    try {
      raw = JSON.parse(filterJson);
    } catch {
      return { ok: false, error: MALFORMED_FILTER };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: MALFORMED_FILTER };
    }
    for (const [key, value] of Object.entries(raw as Record<string, JsonValue>)) {
      if (!allowedCols.has(key)) {
        return { ok: false, error: `Unknown filter field: '${key}'` };
      }
      if (typeof value === 'object' && value !== null) {
        // `{field: {op: val, ...}}` — every operator applies, as in the
        // bracket form; keeping only the first silently widened the result.
        // No operator (`{field: {}}`) leaves the field as it was.
        if (Array.isArray(value)) {
          return { ok: false, error: `Filter on '${key}' is a list; use {"in": [...]}` };
        }
        const conds: FilterCondition[] = [];
        for (const [op, val] of Object.entries(value) as [string, JsonValue][]) {
          const mappedOp = mapOp(op);
          if (!mappedOp) return unknownOp(key, op);
          const value = GEO_OPS.has(mappedOp) ? geoValue(mappedOp, val) : val;
          const bad = geoError(key, op, mappedOp, value);
          if (bad) return { ok: false, error: bad };
          conds.push({ op: mappedOp, value });
        }
        if (conds.length) filters[key] = conds.length === 1 ? conds[0] : conds;
      } else {
        const bad = geoError(key, 'eq', 'eq', value);
        if (bad) return { ok: false, error: bad };
        filters[key] = { op: 'eq', value };
      }
    }
  }

  return { ok: true, filters };
}

/** A decoded keyset cursor: the id and sort-column value of the last row on
 * the previous page. */
export interface DecodedCursor {
  id: string;
  val: JsonValue;
}

/**
 * The cursor of a first page on which entity access left no row: the walk
 * resumes from the start, since the only position after that page is a row the
 * caller may not see. `{"start":true}`, base64url.
 */
export const START_CURSOR = Buffer.from('{"start":true}').toString('base64url');

/** Decode a base64url cursor into `{ id, val }`, or `'start'` for
 * `START_CURSOR`. Returns null when the cursor is missing, malformed, or lacks
 * a usable id/val (caller falls back to offset pagination). */
export function decodeCursor(cursor: string | undefined): DecodedCursor | 'start' | null {
  if (!cursor) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    /* malformed cursor — fall through to offset path */
    return null;
  }
  // `JSON.parse` succeeds on every JSON literal, not only on objects, so the
  // parse landing in the `try` says nothing about the shape. A string, a number,
  // an array and a boolean all reach the property read below harmlessly — but
  // `null` does not: reading `.id` off it throws a TypeError out of a pure
  // parsing function, and the list route answers 500 on a cursor the client
  // fully controls (`?cursor=bnVsbA`). Every one of those payloads is a
  // malformed cursor by this function's contract, so all of them take the same
  // offset fallback.
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
  const { id, val, start } = decoded as { id?: unknown; val?: JsonValue; start?: unknown };
  if (start === true) return 'start';
  if (typeof id === 'string' && id && val !== undefined) return { id, val };
  return null;
}
