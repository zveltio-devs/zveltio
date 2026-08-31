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
import { buildCondition, dynamicSelect } from '../../../db/dynamic.js';
import { tracedQuery } from '../../runtime/index.js';
import {
  getRlsFilters,
  getSingleTenantId,
  matchesRlsFilters,
  rlsJsonConditions,
} from '../../tenancy/index.js';
import { entityAccessRegistry } from '../../tenancy/index.js';
import { getColumnAccess, applyColumnAccess, resolveUserRole } from '../../tenancy/index.js';
import { tenantId } from '../../route-db.js';
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
    if (Number.isNaN(asOf.getTime())) return c.json({ error: 'Invalid as_of date' }, 400);

    // One page, from the database.
    //
    // This used to be `SELECT DISTINCT ON (record_id) …` with no LIMIT: every
    // revision of every record in the collection came back, each snapshot was
    // JSON-parsed in this process, the row policies were applied to the array,
    // and only then was a page sliced out of it. Measured on 200 000 records
    // with two revisions each, 336 ms — of which the policy filtering was
    // 2,2 ms. The reading was the cost, and it grew with the collection while
    // the answer stayed 25 rows. It also materialised the whole set (~50 MB
    // there) inside the process serving every other request.
    //
    // `rlsJsonConditions` is the same four operators against the JSONB
    // snapshot; see it for why `->` and `to_jsonb` rather than `->>`, which
    // would show rows a policy hides.
    const effectiveDbTT = getDb(c, db);
    const rlsTT = await getRlsFilters(collection, user, c.get('authType'));
    const conds = rlsJsonConditions(rlsTT);
    const where =
      conds.length === 0
        ? sql`action <> 'delete'`
        : sql`action <> 'delete' AND ${sql.join(conds, sql` AND `)}`;
    // Snapshots are not all shaped alike: `zv_revisions.data` is jsonb, but some
    // rows hold a jsonb STRING containing serialised JSON rather than the object
    // itself — which is why the code that read them did
    // `typeof r.data === 'string' ? JSON.parse(r.data) : r.data`, and why there
    // is a suite called "time-travel string JSON". A key lookup against the
    // string form finds nothing, silently, so the shape is normalised once here
    // and everything downstream sees an object.
    //
    // The `{` guard keeps a string that is not an object from reaching the cast:
    // a failed cast aborts the statement, and this one runs inside the request's
    // transaction.
    const latest = sql`
        SELECT DISTINCT ON (record_id) record_id, action,
               CASE
                 WHEN jsonb_typeof(data) = 'string' AND left(data #>> '{}', 1) = '{'
                   THEN (data #>> '{}')::jsonb
                 ELSE data
               END AS data
          FROM zv_revisions
         WHERE collection = ${collection}
           AND tenant_id = ${tenantId(c)}::uuid
           AND created_at <= ${asOf.toISOString()}
         ORDER BY record_id, created_at DESC
      `;

    // The same set, without the snapshot column: the count never looks inside a
    // document, and carrying 200 000 JSON values through the sort to throw them
    // away is pure cost. The row policies DO look inside, so this second form is
    // only used when there is nothing to look for.
    const latestKeys =
      conds.length === 0
        ? sql`
        SELECT DISTINCT ON (record_id) record_id, action
          FROM zv_revisions
         WHERE collection = ${collection}
           AND tenant_id = ${tenantId(c)}::uuid
           AND created_at <= ${asOf.toISOString()}
         ORDER BY record_id, created_at DESC
      `
        : latest;

    const offset = (query.page - 1) * query.limit;
    const pageRows = await sql<{ data: JsonValue }>`
        WITH latest AS (${latest})
        SELECT data FROM latest
         WHERE ${where}
         ORDER BY record_id
         LIMIT ${query.limit} OFFSET ${offset}
      `.execute(effectiveDbTT);

    // `total` is the part that still costs, and it is inherent: knowing how many
    // records existed at a point in time needs the DISTINCT ON over the whole
    // history, however small the page is. Measured on the same 200 000 records:
    // the page is 0,25 ms and reads 49 rows; the count is ~250 ms and reads all
    // 400 000. Dropping the JSON from it saves ~18 ms of that and nothing more,
    // so `data` is left out here — the count only needs to know which revision
    // is the latest and whether it was a delete.
    //
    // Kept because the response has always carried `total` and `pages`, and
    // paging clients rely on them. Making it optional is an API change, not a
    // performance fix, so it is not made here.
    const counted = await sql<{ n: string }>`
        WITH latest AS (${latestKeys})
        SELECT count(*)::text AS n FROM latest WHERE ${where}
      `.execute(effectiveDbTT);
    const total = Number(counted.rows[0]?.n ?? 0);

    // Time travel MUST hide columns the role can't read, same as the live list
    // path below — otherwise `?as_of=` leaks columns hidden by column permissions.
    const colAccessTT = await getColumnAccess(db, collection, await resolveUserRole(user));
    const page = pageRows.rows
      .map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data))
      .map((r) => applyColumnAccess(r as Record<string, unknown>, colAccessTT));

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
      // Column permissions apply to virtual collections too.
      const vColAccess = await getColumnAccess(db, collection, await resolveUserRole(user));
      return c.json({
        records: data.map((r: Record<string, unknown>) => applyColumnAccess(r, vColAccess)),
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

      // Apply existing filters — RLS conditions among them, merged above.
      //
      // Through `buildCondition`, the same helper the offset path uses via
      // `dynamicSelect`. This branch used to re-implement it and covered only
      // the six comparison operators, so `in` and `not_in` fell through the
      // `else if` chain and were never applied. Both are valid RLS operators,
      // which meant a row policy written with `in` stopped applying the moment
      // a caller added `?cursor=` — the filters were not refused, they simply
      // were not there.
      for (const [field, cond] of Object.entries(filters)) {
        kQuery = kQuery.where(buildCondition(field, cond));
      }

      // Extension query alters, which the offset path applies through
      // `dynamicSelect`. An extension that narrows a collection was likewise
      // bypassed by paginating with a cursor.
      kQuery = queryAlterRegistry.applyAll(kQuery, tableName, user);

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
          tenantScopeId: getSingleTenantId(),
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
      countMode: query.count,
      // Null whenever a hierarchy is in play, and then nothing is added.
      tenantScopeId: getSingleTenantId(),
      applyAlters: (qb) => queryAlterRegistry.applyAll(qb, tableName, user),
    });
  }

  // Per-record entity access, the same check `GET /:id` has always run.
  //
  // Reading one record was gated; listing the collection was not. So a viewer
  // denied a record by an extension's rule got 404 on the direct read and the
  // record itself in the list — the check protected the narrow door and left the
  // wide one open. An extension registering an ownership rule ("agents see only
  // their own tickets") had it enforced on exactly one of the two ways to read.
  //
  // It happens here rather than in SQL because a check is a JS callback over the
  // whole record, so there is no WHERE to push it into. That has a consequence
  // worth stating rather than hiding: `total` below counts rows BEFORE this
  // filter, so a caller can still infer how many records exist that they may not
  // see. A count is not the rows, and counting through the callback is a query
  // per row.
  if (entityAccessRegistry.hasChecksFor(tableName)) {
    const decisions = await Promise.all(
      result.records.map((r) => entityAccessRegistry.isAllowed(tableName, r, user, 'view')),
    );
    result.records = result.records.filter((_, i) => decisions[i] === true);
  }

  const colAccess = await getColumnAccess(db, collection, await resolveUserRole(user));
  const serialized = (
    await Promise.all(result.records.map((r) => serializeRecord(r, collectionDef)))
  ).map((r) => applyColumnAccess(r, colAccess));

  // ── Expand m2o relations on demand (?expand=customer_id,author_id) ──
  const expandPlan = await resolveExpand(effectiveDb, collectionDef, c.req.query('expand'));
  await applyExpand(
    effectiveDb,
    serialized,
    expandPlan,
    await resolveUserRole(user),
    user,
    c.get('authType'),
  );

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
