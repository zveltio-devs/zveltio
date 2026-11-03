/**
 * The data API request a data block makes, as the visitor.
 *
 * A `collection_list` block names a collection, filters, a sort and a page
 * size; the browser asks `/api/data/<collection>` for that window with the
 * visitor's own session — or none, which the engine serves as the tenant's
 * `public` role (ADR 0017). The engine's rules decide what comes back, so this
 * builds a URL and decides nothing.
 */

export type BlockFilter = { field: string; op: string; value?: unknown };

export const NAME = /^[a-z_][a-z0-9_]*$/;
/** Operators that take no value: the data API reads `true` as "apply it". */
const UNARY = new Set(['null', 'not_null', 'is_null', 'is_not_null']);

/** `[{field, op, value}]` as the data API's `filter` JSON, or `null` when there are none. */
export function filterJson(filters: unknown): string | null {
  if (!Array.isArray(filters)) return null;
  const out: Record<string, Record<string, unknown>> = Object.create(null);
  for (const f of filters as BlockFilter[]) {
    if (!f || typeof f.field !== 'string' || !NAME.test(f.field) || typeof f.op !== 'string') continue;
    out[f.field] = { ...out[f.field], [f.op]: UNARY.has(f.op) ? true : f.value };
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** The list URL for one page (1-based) of a data block, or `null` for a block that names no valid collection. */
export function listUrl(content: Record<string, unknown>, page = 1): string | null {
  const collection = content.collection;
  if (typeof collection !== 'string' || !NAME.test(collection)) return null;
  const q = new URLSearchParams({
    page: String(Math.max(1, page)),
    limit: String(Math.min(Math.max(Number(content.limit) || 20, 1), 100)),
  });
  if (typeof content.sort_field === 'string' && NAME.test(content.sort_field)) {
    q.set('sort', content.sort_field);
    q.set('order', content.sort_dir === 'asc' ? 'asc' : 'desc');
  }
  const filter = filterJson(content.filters);
  if (filter) q.set('filter', filter);
  return `/api/data/${collection}?${q}`;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

let dataFetch: Fetch = (url, init) => fetch(url, { credentials: 'include', ...init });

/**
 * The `fetch` data blocks read with: by default the browser's, same origin,
 * with the session cookie. A host whose engine is elsewhere, or that must send
 * a tenant header, hands its own over once.
 */
export function useDataFetch(f: Fetch): void {
  dataFetch = f;
}

/** Fetch a data block's window with the host's `fetch`. */
export function fetchRows(url: string): Promise<Response> {
  return dataFetch(url);
}
