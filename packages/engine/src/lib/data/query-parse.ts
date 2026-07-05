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
import type { FilterCondition } from '../../db/dynamic.js';
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
});

/** The parsed, validated list query. */
export type ParsedQuery = z.infer<typeof QuerySchema>;

/** System columns always allowed for sort/filter, regardless of schema. */
const SYSTEM_COLS = new Set([
  'id',
  'created_at',
  'updated_at',
  'status',
  'created_by',
  'updated_by',
]);

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
  in: 'in',
  not_in: 'not_in',
  null: 'null',
  is_null: 'null',
  not_null: 'not_null',
  is_not_null: 'not_null',
};

const BRACKET_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z_]+)\]$/;
const NUMERIC_OPS = new Set<FilterCondition['op']>(['gt', 'gte', 'lt', 'lte']);

/** Build the set of columns clients are allowed to sort/filter by. Hitting
 * Postgres with an unknown column surfaces as a 500 ("column X does not
 * exist") — the caller uses this to return a clean 400 at the edge instead. */
export function buildAllowedCols(collectionDef: CollectionDef | null | undefined): Set<string> {
  const rawFields = normalizeFields(collectionDef);
  return new Set<string>([...SYSTEM_COLS, ...rawFields.map((f) => f.name).filter(Boolean)]);
}

/** Result of `parseFilters`: either the parsed filter map, or a 400 error to
 * surface (unknown filter field). */
export type ParseFiltersResult =
  | { ok: true; filters: Record<string, FilterCondition> }
  | { ok: false; error: string };

/** Parse filters from the two supported formats (both can be used together):
 *
 *  1. JSON:    ?filter={"price":{"gt":50},"title":{"like":"pro"}}
 *  2. Bracket: ?price[gt]=50&title[like]=pro  (simpler for curl/browser)
 *
 * When both are provided for the same field, JSON takes precedence. An unknown
 * field in the JSON format is a hard 400 (returned via `error`); an unknown
 * field in the bracket format is silently skipped (legacy behaviour). */
export function parseFilters(
  queryParams: Record<string, string>,
  filterJson: string | undefined,
  allowedCols: Set<string>,
): ParseFiltersResult {
  const filters: Record<string, FilterCondition> = {};

  // Format 2: bracket syntax — parse before JSON so JSON can override
  for (const [paramKey, paramVal] of Object.entries(queryParams)) {
    const m = BRACKET_RE.exec(paramKey);
    if (!m) continue;
    const [, field, op] = m;
    if (!allowedCols.has(field)) continue; // silently skip unknown fields
    const mappedOp = OP_ALIAS[op];
    if (!mappedOp) continue;
    // Coerce numeric-looking values to numbers for comparison operators
    const value =
      NUMERIC_OPS.has(mappedOp) && paramVal !== '' && !isNaN(Number(paramVal))
        ? Number(paramVal)
        : paramVal;
    filters[field] = { op: mappedOp, value };
  }

  // Format 1: JSON (overrides bracket for same field)
  if (filterJson) {
    let raw: Record<string, JsonValue> | null = null;
    try {
      raw = JSON.parse(filterJson);
    } catch {
      /* malformed JSON — ignore */
    }
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        if (!allowedCols.has(key)) {
          return { ok: false, error: `Unknown filter field: '${key}'` };
        }
        if (typeof value === 'object' && value !== null) {
          const [op, val] = Object.entries(value)[0] as [string, JsonValue];
          const mappedOp = OP_ALIAS[op];
          if (mappedOp) filters[key] = { op: mappedOp, value: val };
        } else {
          filters[key] = { op: 'eq', value };
        }
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

/** Decode a base64url cursor into `{ id, val }`. Returns null when the cursor
 * is missing, malformed, or lacks a usable id/val (caller falls back to
 * offset pagination). */
export function decodeCursor(cursor: string | undefined): DecodedCursor | null {
  if (!cursor) return null;
  let decoded: { id: string; val: JsonValue } = { id: '', val: null };
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    /* malformed cursor — fall through to offset path */
    return null;
  }
  if (decoded.id && decoded.val !== undefined) return decoded;
  return null;
}
