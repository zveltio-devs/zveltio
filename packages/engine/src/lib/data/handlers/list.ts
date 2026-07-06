/**
 * GET /:collection list handler (H-05 split of `routes/data.ts`).
 *
 * The single hottest read path: query-result cache, time-travel, virtual
 * sources, filter/sort parsing, RLS injection, cursor + offset pagination,
 * column access, m2o expansion, ETag/304 and next_cursor. The validated
 * query is passed in (the `zValidator('query', QuerySchema)` middleware stays
 * on the route) so this stays a plain `(c, db, query)` function. Byte-identical
 * to the pre-split inline handler — zero behaviour change.
 */

import type { Context } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../../db/index.js';
import type { DynamicRecord } from '../../../db/dynamic-types.js';
import { DDLManager } from '../ddl-manager.js';
import { queryAlterRegistry } from '../query-alter.js';
import { dynamicSelect } from '../../../db/dynamic.js';
import { tracedQuery } from '../../runtime/index.js';
import { getRlsFilters } from '../../rls.js';
import { getColumnAccess, applyColumnAccess } from '../../column-permissions.js';
import { buildQueryCacheKey, getQueryCache, setQueryCache } from '../query-cache.js';
import { virtualList } from '../../virtual-collection-adapter.js';
import type { CollectionDef, JsonValue } from '../types.js';
import { serializeRecord, resolveExpand, applyExpand, computeEtag } from '../shape.js';
import { buildAllowedCols, parseFilters, decodeCursor } from '../query-parse.js';
import type { ParsedQuery } from '../query-parse.js';
import { getDb, getTenantId, dynamicDb, getVirtualConfig } from '../write-pipeline.js';
import { checkAccess } from '../auth.js';

export async function listRecords(c: Context, db: Database, query: ParsedQuery): Promise<Response> {
  const collection = c.req.param('collection')!;
  const user = c.get('user');

  if (!(await checkAccess(db, user, collection, 'read'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // ── Query result cache (Valkey) ────────────────────────────────
  // Only cache standard offset queries (no time-travel, no cursor, no virtual sources)
  // Tenant id is part of the cache namespace so a user who is a member of
  // multiple tenants doesn't get tenant A's rows from cache while
  // querying as tenant B.
  const qcKey = buildQueryCacheKey(collection, user.id, c.req.url, getTenantId(c));
  if (!query.as_of && !query.cursor) {
    const cached = await getQueryCache(qcKey);
    if (cached) {
      // Still compute ETag from cached records so If-None-Match / 304 works on cache hits
      const etag = `"${await computeEtag(cached.records ?? [])}"`;
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, max-age=0, must-revalidate');
      c.header('Vary', 'Cookie, X-API-Key, Authorization');
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
      return c.json(cached);
    }
  }

  // ── Time Travel: reconstruct state at a given point in time ────
  if (query.as_of) {
    const asOf = new Date(query.as_of);
    if (isNaN(asOf.getTime())) return c.json({ error: 'Invalid as_of date' }, 400);

    // Get the latest revision per record_id up to as_of
    // P0: use effectiveDb (tenant-isolated transaction) to prevent cross-tenant reads
    const effectiveDbTT = getDb(c, db);
    const revs = await sql<{ record_id: string; action: string; data: JsonValue }>`
        SELECT DISTINCT ON (record_id)
          record_id, action, data
        FROM zv_revisions
        WHERE collection = ${collection}
          AND created_at <= ${asOf.toISOString()}
        ORDER BY record_id, created_at DESC
      `.execute(effectiveDbTT);

    // Exclude deleted records; data column holds the snapshot
    const records = revs.rows
      .filter((r) => r.action !== 'delete')
      .map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));

    const total = records.length;
    const offset = (query.page - 1) * query.limit;
    const page = records.slice(offset, offset + query.limit);

    return c.json({
      records: page,
      pagination: {
        total,
        page: query.page,
        limit: query.limit,
        pages: Math.ceil(total / query.limit),
      },
      time_travel: { as_of: asOf.toISOString() },
    });
  }

  // Virtual collection: proxy to external API
  const virtualConfig = await getVirtualConfig(db, collection);
  if (virtualConfig) {
    try {
      // Parse query.filter into VirtualQuery.filters — translated to API URL params (no fetch-all)
      const vFilters: Array<{ field: string; op: string; value: unknown }> = [];
      if (query.filter) {
        try {
          const raw = JSON.parse(query.filter) as Record<string, JsonValue>;
          for (const [key, value] of Object.entries(raw)) {
            if (typeof value === 'object' && value !== null) {
              const [op, val] = Object.entries(value)[0] as [string, JsonValue];
              vFilters.push({ field: key, op, value: val });
            } else {
              vFilters.push({ field: key, op: 'eq', value });
            }
          }
        } catch {
          /* invalid JSON — skip */
        }
      }

      const { data, total } = await virtualList(virtualConfig, {
        filters: vFilters,
        sort: query.sort ? { field: query.sort, direction: query.order } : undefined,
        page: query.page,
        limit: query.limit,
        search: query.search,
      });
      return c.json({
        records: data,
        pagination: {
          total,
          page: query.page,
          limit: query.limit,
          pages: Math.ceil(total / query.limit),
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
    }
  }

  const collectionDef = (await DDLManager.getCollection(db, collection)) as CollectionDef | null;
  if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

  const tableName = DDLManager.getTableName(collection);

  // Columns clients may sort/filter by. Unknown columns become a clean 400
  // at the edge instead of a Postgres 500.
  const allowedCols = buildAllowedCols(collectionDef);

  // Parse filters — bracket + JSON formats (JSON wins on the same field).
  const parsed = parseFilters(c.req.query(), query.filter, allowedCols);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const filters = parsed.filters;

  if (query.sort && !allowedCols.has(query.sort)) {
    return c.json({ error: `Unknown sort field: '${query.sort}'` }, 400);
  }

  // ── RLS injection ──────────────────────────────────────────────
  // Merge row-level security filters into existing query filters.
  // RLS conditions are ANDed with any user-supplied filters.
  const rlsFilters = await getRlsFilters(collection, user, c.get('authType'));
  for (const { field, condition } of rlsFilters) {
    filters[field] = condition; // RLS wins over same-field user filter
  }

  const effectiveDb = getDb(c, db);
  const sortField = query.sort ?? 'created_at';

  // ── Cursor-based pagination ────────────────────────────────────
  // Used when `cursor` is provided and page is still default (1).
  // Avoids OFFSET cost on large tables.
  const useCursor = !!query.cursor && query.page === 1;
  let result: { records: DynamicRecord[]; total: number };

  if (useCursor) {
    const decoded = decodeCursor(query.cursor);

    if (decoded) {
      // Build keyset query directly with Kysely for proper compound pagination
      // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
      let kQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll();

      // Apply existing filters
      for (const [field, cond] of Object.entries(filters)) {
        if (cond.op === 'eq') kQuery = kQuery.where(field, '=', cond.value);
        else if (cond.op === 'neq') kQuery = kQuery.where(field, '!=', cond.value);
        else if (cond.op === 'lt') kQuery = kQuery.where(field, '<', cond.value);
        else if (cond.op === 'lte') kQuery = kQuery.where(field, '<=', cond.value);
        else if (cond.op === 'gt') kQuery = kQuery.where(field, '>', cond.value);
        else if (cond.op === 'gte') kQuery = kQuery.where(field, '>=', cond.value);
      }

      // Add keyset condition (compound: sort col + tiebreak by id)
      if (query.order === 'asc') {
        kQuery = kQuery.where(
          sql`(${sql.ref(sortField)} > ${decoded.val}) OR (${sql.ref(sortField)} = ${decoded.val} AND id > ${decoded.id})`,
        );
        kQuery = kQuery.orderBy(sortField, 'asc').orderBy('id', 'asc');
      } else {
        kQuery = kQuery.where(
          sql`(${sql.ref(sortField)} < ${decoded.val}) OR (${sql.ref(sortField)} = ${decoded.val} AND id < ${decoded.id})`,
        );
        kQuery = kQuery.orderBy(sortField, 'desc').orderBy('id', 'desc');
      }

      // Fetch limit+1 to detect whether a next page exists without a count query
      kQuery = kQuery.limit(query.limit + 1);
      const rows: DynamicRecord[] = await kQuery.execute();
      const hasMore = rows.length > query.limit;
      result = {
        records: hasMore ? rows.slice(0, query.limit) : rows,
        total: hasMore ? -1 : rows.length,
      };
    } else {
      // Malformed cursor — fall back to offset
      const offset = (query.page - 1) * query.limit;
      result = await tracedQuery(`${tableName}.list`, () =>
        dynamicSelect(effectiveDb, tableName, {
          filters,
          sort: query.sort ? { field: query.sort, direction: query.order } : undefined,
          limit: query.limit,
          offset,
          fts: query.search ? query.search.trim().substring(0, 500) : undefined,
          hasTrgm: !!collectionDef.has_trgm,
          applyAlters: (qb) => queryAlterRegistry.applyAll(qb, tableName, user),
        }),
      );
    }
  } else {
    // Standard OFFSET-based pagination (backwards-compatible)
    const offset = (query.page - 1) * query.limit;
    // FTS + filters run in a single query via dynamicSelect (fts param adds
    // search_vector @@ websearch_to_tsquery() alongside any other WHERE conditions)
    result = await dynamicSelect(effectiveDb, tableName, {
      filters,
      sort: query.sort ? { field: query.sort, direction: query.order } : undefined,
      limit: query.limit,
      offset,
      fts: query.search ? query.search.trim().substring(0, 500) : undefined,
      hasTrgm: !!collectionDef.has_trgm,
      applyAlters: (qb) => queryAlterRegistry.applyAll(qb, tableName, user),
    });
  }

  const colAccess = await getColumnAccess(db, collection, user.role ?? 'public');
  const serialized = (
    await Promise.all(result.records.map((r) => serializeRecord(r, collectionDef)))
  ).map((r) => applyColumnAccess(r, colAccess));

  // ── Expand m2o relations on demand (?expand=customer_id,author_id) ──
  const expandPlan = await resolveExpand(effectiveDb, collectionDef, c.req.query('expand'));
  await applyExpand(effectiveDb, serialized, expandPlan);

  // ── ETag + Cache-Control ───────────────────────────────────────
  const etag = `"${await computeEtag(serialized)}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', 'private, max-age=0, must-revalidate');
  c.header('Vary', 'Cookie, X-API-Key, Authorization');

  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return c.body(null, 304);
  }

  // ── Build next_cursor ─────────────────────────────────────────
  // Cursor mode: result.total === -1 means hasMore (limit+1 trick returned extra row)
  // Offset mode: compare offset+returned vs total count
  let next_cursor: string | null = null;
  const offsetHasMore =
    result.total >= 0 ? (query.page - 1) * query.limit + serialized.length < result.total : false;
  const cursorHasMore = result.total === -1; // set by limit+1 trick above
  if (serialized.length > 0 && (cursorHasMore || offsetHasMore)) {
    const lastRow = serialized[serialized.length - 1];
    if (lastRow?.id !== undefined) {
      next_cursor = Buffer.from(
        JSON.stringify({ id: lastRow.id, val: lastRow[sortField] ?? lastRow.created_at }),
      ).toString('base64url');
    }
  }

  // Response shape matches the rest of the list endpoints (time-travel, virtual)
  // and the contract consumed by Studio + SDK: { records, pagination, next_cursor? }.
  // A prior refactor renamed these to { data, total, page, limit, pages } which
  // silently broke every client — the studio data tab was stuck on its spinner
  // because `dataRes.records` was undefined and rendering threw on records.length.
  const listResponse = {
    records: serialized,
    pagination: {
      total: result.total >= 0 ? result.total : undefined,
      page: query.page,
      limit: query.limit,
      pages: result.total >= 0 ? Math.ceil(result.total / query.limit) : undefined,
    },
    next_cursor,
  };

  // Cache the response (fire-and-forget, non-blocking). A cache write
  // failure is recoverable — the next request just goes back to the DB
  // — but a chronic failure indicates Valkey trouble worth surfacing.
  if (!query.as_of && !query.cursor) {
    setQueryCache(qcKey, listResponse, user.id).catch((err) => {
      console.warn(`[data] setQueryCache failed for ${collection}:`, (err as Error).message);
    });
  }

  return c.json(listResponse);
}
