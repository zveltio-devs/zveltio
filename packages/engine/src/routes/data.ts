import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { checkPermission } from '../lib/permissions.js';
// AI auto-embedding is now handled by the `ai` extension via record.created /
// record.updated events emitted by engineEvents below.
import { engineEvents, AbortHookError } from '../lib/event-bus.js';
import { queryAlterRegistry } from '../lib/query-alter.js';
import { entityAccessRegistry } from '../lib/entity-access.js';
import { dynamicSelect, dynamicInsert, dynamicUpdate, dynamicDelete } from '../db/dynamic.js';
import { hashApiKey } from '../lib/api-key-hash.js';
import { tracedQuery } from '../lib/telemetry.js';
import { getRlsFilters } from '../lib/rls.js';
import {
  getColumnAccess,
  applyColumnAccess,
  filterWritableFields,
} from '../lib/column-permissions.js';
import { buildQueryCacheKey, getQueryCache, setQueryCache } from '../lib/query-cache.js';
import type { CollectionDef, JsonValue, RequestUser } from '../lib/data/types.js';
import type { DynamicRecord } from '../db/dynamic-types.js';
import { serializeRecord, resolveExpand, applyExpand, computeEtag } from '../lib/data/shape.js';
import {
  QuerySchema,
  buildAllowedCols,
  parseFilters,
  decodeCursor,
} from '../lib/data/query-parse.js';
import {
  processInput,
  afterWrite,
  handlePgErrors,
  getVirtualConfig,
  getDb,
  getTenantId,
  dynamicDb,
  runAtomic,
  isUuid,
} from '../lib/data/write-pipeline.js';

export type { RequestUser };

declare module 'hono' {
  interface ContextVariableMap {
    user: RequestUser;
    authType: 'session' | 'api_key';
  }
}
import {
  virtualList,
  virtualGetOne,
  virtualCreate,
  virtualUpdate,
  virtualDelete,
} from '../lib/virtual-collection-adapter.js';

// Authenticate request — session or API key
async function authenticate(
  c: Context,
  // biome-ignore lint/suspicious/noExplicitAny: better-auth instance — no exported type, mirrors the loader's documented survivor; tracked in docs/HARDENING-9-PLAN.md H-05
  auth: any,
  db: Database,
): Promise<{ user: RequestUser; authType: string } | null> {
  // Try session
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session) return { user: session.user, authType: 'session' };

  // Try API key
  const rawKey = c.req.header('X-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');

  if (rawKey?.startsWith('zvk_')) {
    const apiKey = await validateApiKey(db, rawKey);
    if (apiKey) {
      return {
        user: {
          id: `apikey:${apiKey.id}`,
          name: apiKey.name,
          role: 'api_key',
          // Pass scopes through so checkAccess() can enforce them per collection/action.
          scopes: apiKey.scopes,
        },
        authType: 'api_key',
      };
    }
  }

  return null;
}

async function validateApiKey(
  db: Database,
  rawKey: string,
): Promise<import('../db/schema.js').ZvApiKeyRow | null> {
  const hash = await hashApiKey(rawKey);
  const apiKey = await db
    .selectFrom('zv_api_keys')
    .selectAll()
    .where('key_hash', '=', hash)
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!apiKey) return null;
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) return null;

  // Update last_used_at — fire-and-forget; non-blocking on hot path
  db.updateTable('zv_api_keys')
    .set({ last_used_at: new Date() })
    .where('id', '=', apiKey.id)
    .execute()
    .catch((err) => console.error('[validateApiKey] last_used_at update failed:', err));

  return apiKey;
}

async function checkAccess(
  db: Database,
  user: RequestUser,
  collection: string,
  action: string,
): Promise<boolean> {
  // Note: never short-circuit on `user.role === 'admin'`. Better-Auth doesn't
  // populate `role` on the session for magic-link / OAuth flows, so we route
  // every check through checkPermission() — it handles god bypass (DB + HMAC
  // cache) first, then Casbin, so admins with proper policies still get
  // access without depending on a session field that may be missing.
  if (user.role === 'api_key') {
    // API keys cannot access system tables
    const tableName = DDLManager.getTableName(collection);
    if (tableName.startsWith('zv_') && !tableName.startsWith('zvd_')) return false;

    // Scopes format: Array<{ collection: string; actions: string[] }>.
    // Empty array = full access (backwards-compatible default).
    // Wildcard collection '*' or action '*' grants broad access.
    //
    // A malformed JSON blob in `scopes` used to crash the auth check
    // (uncaught JSON.parse). Fail closed — if we can't tell what the key
    // is allowed to do, refuse. The API key remains usable once an admin
    // fixes the row.
    const rawScopes = user.scopes;
    if (rawScopes) {
      let scopes: Array<{ collection: string; actions: string[] }> = [];
      if (typeof rawScopes === 'string') {
        try {
          scopes = JSON.parse(rawScopes);
        } catch (err) {
          console.warn(
            `[auth] api_key ${user.id} has unparseable scopes JSON — refusing access:`,
            (err as Error).message,
          );
          return false;
        }
      } else {
        scopes = rawScopes as Array<{ collection: string; actions: string[] }>;
      }
      if (!Array.isArray(scopes)) {
        console.warn(`[auth] api_key ${user.id} scopes is not an array — refusing access`);
        return false;
      }
      if (scopes.length > 0) {
        const match = scopes.find((s) => s.collection === collection || s.collection === '*');
        if (!match) return false;
        if (!match.actions.includes(action) && !match.actions.includes('*')) return false;
      }
    }
    return true;
  }
  return checkPermission(user.id, collection, action);
}

// biome-ignore lint/suspicious/noExplicitAny: better-auth instance — no exported type, mirrors the loader's documented survivor; tracked in docs/HARDENING-9-PLAN.md H-05
export function dataRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const result = await authenticate(c, auth, db);
    if (!result) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', result.user);
    c.set('authType', result.authType as 'session' | 'api_key');
    await next();
  });

  // ── GET /:collection — List records ─────────────────────────────
  app.get('/:collection', zValidator('query', QuerySchema), async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');
    const query = c.req.valid('query');

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
  });

  // ── POST /:collection/bulk — Bulk insert ─────────────────────────
  app.post('/:collection/bulk', async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');

    if (!(await checkAccess(db, user, collection, 'create'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body?.records) || body.records.length === 0) {
      return c.json({ error: 'Body must be { records: [...] } with at least one item' }, 400);
    }
    if (body.records.length > 500) {
      return c.json({ error: 'Bulk insert limited to 500 records per request' }, 400);
    }

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);
    const created: DynamicRecord[] = [];
    const errors: Array<{ index: number; errors: string[] }> = [];

    // Per-row pre-insert hook. A hook abort becomes a per-row error so the
    // rest of the batch still proceeds. Non-abort exceptions roll back the
    // entire transaction (something is genuinely wrong).
    await runAtomic(effectiveDb, async (trx: Database) => {
      for (let i = 0; i < body.records.length; i++) {
        const { errors: valErrors, processed } = await processInput(body.records[i], collectionDef);
        if (valErrors.length > 0) {
          errors.push({ index: i, errors: valErrors });
          continue;
        }

        let finalInsert: Record<string, unknown>;
        try {
          const hooked = await engineEvents.runBefore('record.beforeInsert', {
            collection,
            data: { ...processed, created_by: user.id, updated_by: user.id },
            userId: user.id,
          });
          finalInsert = hooked.data;
        } catch (err) {
          if (err instanceof AbortHookError) {
            errors.push({ index: i, errors: [`EXT_HOOK_ABORTED: ${err.reason}`] });
            continue;
          }
          throw err;
        }

        const record = await dynamicInsert(trx, tableName, finalInsert);
        created.push(record as DynamicRecord);
      }
    });

    const tid = getTenantId(c);
    for (const record of created) {
      afterWrite(effectiveDb, {
        collection,
        recordId: record.id,
        action: 'create',
        data: record,
        userId: user.id,
        tenantId: tid,
      }).catch((err: Error) => {
        console.warn(`[data] afterWrite(create, ${collection}/${record.id}) failed:`, err.message);
      });
    }

    return c.json(
      { created: created.length, records: created, errors },
      errors.length > 0 ? 207 : 201,
    );
  });

  // ── PATCH /:collection/bulk — Bulk partial update ─────────────────
  app.patch('/:collection/bulk', async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');

    if (!(await checkAccess(db, user, collection, 'update'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body?.records) || body.records.length === 0) {
      return c.json({ error: 'Body must be { records: [{id, ...fields}] }' }, 400);
    }
    if (body.records.length > 500) {
      return c.json({ error: 'Bulk update limited to 500 records per request' }, 400);
    }
    if (body.records.some((r: { id?: unknown }) => !isUuid(String(r?.id)))) {
      return c.json({ error: 'Every record must have a valid UUID id' }, 400);
    }

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);
    const updated: DynamicRecord[] = [];
    const errors: Array<{ index: number; id: string; errors: string[] }> = [];

    // Per-row pre-update hook. Before-row fetched inside the transaction so
    // a concurrent write between read and update is at least visible in the
    // same tx snapshot. Hook abort becomes a per-row error.
    await runAtomic(effectiveDb, async (trx: Database) => {
      for (let i = 0; i < body.records.length; i++) {
        const { id, ...fields } = body.records[i];
        const { errors: valErrors, processed } = await processInput(fields, collectionDef, true);
        if (valErrors.length > 0) {
          errors.push({ index: i, id, errors: valErrors });
          continue;
        }

        const beforeRow = await dynamicDb(trx)
          .selectFrom(tableName)
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        if (!beforeRow) {
          errors.push({ index: i, id, errors: ['Record not found'] });
          continue;
        }

        let finalPatch: Record<string, unknown>;
        try {
          const hooked = await engineEvents.runBefore('record.beforeUpdate', {
            collection,
            id,
            before: beforeRow,
            patch: { ...processed, updated_by: user.id },
            userId: user.id,
          });
          finalPatch = hooked.patch;
        } catch (err) {
          if (err instanceof AbortHookError) {
            errors.push({ index: i, id, errors: [`EXT_HOOK_ABORTED: ${err.reason}`] });
            continue;
          }
          throw err;
        }

        const record = await dynamicUpdate(trx, tableName, id, finalPatch);
        if (record) updated.push(record as DynamicRecord);
        else errors.push({ index: i, id, errors: ['Record not found'] });
      }
    });

    const tid = getTenantId(c);
    for (const record of updated) {
      afterWrite(effectiveDb, {
        collection,
        recordId: record.id,
        action: 'update',
        data: record,
        userId: user.id,
        tenantId: tid,
      }).catch((err: Error) => {
        console.warn(`[data] afterWrite(update, ${collection}/${record.id}) failed:`, err.message);
      });
    }

    return c.json(
      { updated: updated.length, records: updated, errors },
      errors.length > 0 ? 207 : 200,
    );
  });

  // ── DELETE /:collection/bulk — Bulk delete ────────────────────────
  app.delete('/:collection/bulk', async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');

    if (!(await checkAccess(db, user, collection, 'delete'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (!(await DDLManager.getCollection(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body?.ids) || body.ids.length === 0) {
      return c.json({ error: 'Body must be { ids: [...] }' }, 400);
    }
    if (body.ids.length > 500) {
      return c.json({ error: 'Bulk delete limited to 500 records per request' }, 400);
    }
    if (body.ids.some((id: unknown) => !isUuid(String(id)))) {
      return c.json({ error: 'All ids must be valid UUIDs' }, 400);
    }

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);

    const existing = await dynamicDb(effectiveDb)
      .selectFrom(tableName)
      .selectAll()
      .where('id', 'in', body.ids)
      .execute();

    // Per-row pre-delete hook. Aborted IDs drop out of the delete set and
    // are reported back as per-row errors (so the caller can distinguish
    // them from rows that didn't exist).
    const aborted: Array<{ id: string; reason: string }> = [];
    const allowed: DynamicRecord[] = [];
    for (const record of existing) {
      try {
        await engineEvents.runBefore('record.beforeDelete', {
          collection,
          id: record.id,
          record,
          userId: user.id,
        });
        allowed.push(record);
      } catch (err) {
        if (err instanceof AbortHookError) {
          aborted.push({ id: record.id, reason: err.reason });
        } else {
          throw err;
        }
      }
    }

    if (allowed.length > 0) {
      await dynamicDb(effectiveDb)
        .deleteFrom(tableName)
        .where(
          'id',
          'in',
          allowed.map((r) => r.id),
        )
        .execute();

      const tid = getTenantId(c);
      for (const record of allowed) {
        afterWrite(effectiveDb, {
          collection,
          recordId: record.id,
          action: 'delete',
          data: record,
          userId: user.id,
          tenantId: tid,
        }).catch((err: Error) => {
          console.warn(
            `[data] afterWrite(delete, ${collection}/${record.id}) failed:`,
            err.message,
          );
        });
      }
    }

    return c.json(
      {
        deleted: allowed.length,
        ids: allowed.map((r) => r.id),
        ...(aborted.length > 0 ? { aborted } : {}),
      },
      aborted.length > 0 ? 207 : 200,
    );
  });

  // ── GET /:collection/:id — Get single record ─────────────────────
  app.get('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');
    const asOfRaw = c.req.query('as_of');

    if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

    if (!(await checkAccess(db, user, collection, 'read'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // ── Time Travel: single record at a given point in time ────────
    if (asOfRaw) {
      const asOf = new Date(asOfRaw);
      if (isNaN(asOf.getTime())) return c.json({ error: 'Invalid as_of date' }, 400);

      // P0: use effectiveDb for tenant isolation in time-travel queries
      const effectiveDbTTSingle = getDb(c, db);
      const rev = await sql<{ action: string; data: JsonValue; created_at: string }>`
        SELECT action, data, created_at
        FROM zv_revisions
        WHERE collection = ${collection}
          AND record_id = ${id}
          AND created_at <= ${asOf.toISOString()}
        ORDER BY created_at DESC
        LIMIT 1
      `.execute(effectiveDbTTSingle);

      if (rev.rows.length === 0)
        return c.json({ error: 'Record not found at this point in time' }, 404);
      if (rev.rows[0].action === 'delete')
        return c.json({ error: 'Record was deleted before this point in time' }, 404);

      const data =
        typeof rev.rows[0].data === 'string' ? JSON.parse(rev.rows[0].data) : rev.rows[0].data;
      return c.json({
        record: data,
        time_travel: { as_of: asOf.toISOString(), snapshot_at: rev.rows[0].created_at },
      });
    }

    // Virtual collection: proxy to external API
    const virtualConfigSingle = await getVirtualConfig(db, collection);
    if (virtualConfigSingle) {
      try {
        const record = await virtualGetOne(virtualConfigSingle, id);
        if (!record) return c.json({ error: 'Record not found' }, 404);
        return c.json({ record });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);

    // Build query with RLS conditions so a user cannot fetch a record
    // they're not allowed to see by guessing its ID.
    const rlsSingle = await getRlsFilters(collection, user, c.get('authType'));
    // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
    let recordQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);

    for (const { field, condition } of rlsSingle) {
      if (condition.op === 'eq') recordQuery = recordQuery.where(field, '=', condition.value);
      else if (condition.op === 'neq')
        recordQuery = recordQuery.where(field, '!=', condition.value);
    }

    // Apply extension query alters (tenant isolation, soft-delete, etc.)
    recordQuery = queryAlterRegistry.applyAll(recordQuery, tableName, user);

    const record = await recordQuery.executeTakeFirst();

    if (!record) return c.json({ error: 'Record not found' }, 404);

    // Per-record entity-access check. A 404 (not 403) hides whether the
    // record exists at all from a viewer without permission.
    if (!(await entityAccessRegistry.isAllowed(tableName, record, user, 'view'))) {
      return c.json({ error: 'Record not found' }, 404);
    }

    const colAccess = await getColumnAccess(db, collection, user.role ?? 'public');
    const serializedRecord = applyColumnAccess(
      await serializeRecord(record, collectionDef),
      colAccess,
    );

    // Expand m2o relations on demand
    const singleExpand = await resolveExpand(effectiveDb, collectionDef, c.req.query('expand'));
    if (singleExpand.length > 0) {
      await applyExpand(effectiveDb, [serializedRecord], singleExpand);
    }

    // ETag + Cache-Control for single record
    const singleEtag = `"${await computeEtag([serializedRecord])}"`;
    c.header('ETag', singleEtag);
    c.header('Cache-Control', 'private, max-age=0, must-revalidate');
    c.header('Vary', 'Cookie, X-API-Key, Authorization');

    const ifNoneMatchSingle = c.req.header('If-None-Match');
    if (ifNoneMatchSingle && ifNoneMatchSingle === singleEtag) {
      return c.body(null, 304);
    }

    return c.json(serializedRecord);
  });

  // ── POST /:collection — Create record ────────────────────────────
  app.post('/:collection', async (c) => {
    const collection = c.req.param('collection');
    const user = c.get('user');

    if (!(await checkAccess(db, user, collection, 'create'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Virtual collection: proxy create to external API
    const virtualConfigCreate = await getVirtualConfig(db, collection);
    if (virtualConfigCreate) {
      try {
        const body = await c.req.json();
        const record = await virtualCreate(virtualConfigCreate, body);
        return c.json({ record }, 201);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(collection);
    const body = await c.req.json();

    const { errors, processed } = await processInput(body, collectionDef);
    if (errors.length > 0) return c.json({ errors }, 422);

    const colAccessCreate = await getColumnAccess(db, collection, user.role ?? 'public');
    const { data: allowedData, blocked: blockedCreate } = filterWritableFields(
      processed,
      colAccessCreate,
    );
    if (blockedCreate.length > 0) {
      return c.json(
        { error: `Fields are read-only for your role: ${blockedCreate.join(', ')}` },
        403,
      );
    }

    const effectiveDb = getDb(c, db);
    const toInsert = { ...allowedData, created_by: user.id, updated_by: user.id };

    // Pre-insert hooks: extensions can mutate the payload (e.g. geocode an
    // address, attach a computed score) or abort (e.g. quota check).
    let finalInsert: Record<string, unknown>;
    try {
      const hooked = await engineEvents.runBefore('record.beforeInsert', {
        collection,
        data: toInsert,
        userId: user.id,
      });
      finalInsert = hooked.data;
    } catch (err) {
      if (err instanceof AbortHookError) {
        return c.json({ code: 'EXT_HOOK_ABORTED', reason: err.reason }, 422);
      }
      throw err;
    }

    const result = await handlePgErrors(c, async () => {
      const record = await tracedQuery(`${tableName}.create`, () =>
        dynamicInsert(effectiveDb, tableName, finalInsert),
      );
      await afterWrite(effectiveDb, {
        collection,
        recordId: record.id,
        action: 'create',
        data: record,
        userId: user.id,
        tenantId: getTenantId(c),
      });
      const serialized: Record<string, unknown> = await serializeRecord(record, collectionDef);
      return c.json(serialized, 201);
    });
    return result as Response;
  });

  // ── PUT /:collection/:id — Replace record ────────────────────────
  app.put('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');

    if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

    if (!(await checkAccess(db, user, collection, 'update'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Virtual collection: proxy update to external API
    const virtualConfigPut = await getVirtualConfig(db, collection);
    if (virtualConfigPut) {
      try {
        const body = await c.req.json();
        const record = await virtualUpdate(virtualConfigPut, id, body);
        return c.json({ record });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(collection);
    const body = await c.req.json();

    const { errors, processed } = await processInput(body, collectionDef);
    if (errors.length > 0) return c.json({ errors }, 422);

    const effectiveDb = getDb(c, db);
    const toUpdate = { ...processed, updated_by: user.id };

    // Pre-update hooks need the current row for the `before` field. Read it
    // once — if the record doesn't exist (or extension query alters hide it)
    // we short-circuit before invoking any hooks.
    let beforeQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);
    beforeQuery = queryAlterRegistry.applyAll(beforeQuery, tableName, user);
    const beforeRow = await beforeQuery.executeTakeFirst();
    if (!beforeRow) return c.json({ error: 'Record not found' }, 404);

    // Entity-access enforcement: a row visible to query-alter still needs
    // explicit permission to be modified. 403 distinguishes "you cannot
    // touch this row" from the 404 we'd return for a hidden row.
    if (!(await entityAccessRegistry.isAllowed(tableName, beforeRow, user, 'update'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    let finalPatch: Record<string, unknown>;
    try {
      const hooked = await engineEvents.runBefore('record.beforeUpdate', {
        collection,
        id,
        before: beforeRow,
        patch: toUpdate,
        userId: user.id,
      });
      finalPatch = hooked.patch;
    } catch (err) {
      if (err instanceof AbortHookError) {
        return c.json({ code: 'EXT_HOOK_ABORTED', reason: err.reason }, 422);
      }
      throw err;
    }

    const result = await handlePgErrors(c, async () => {
      const record = await tracedQuery(`${tableName}.update`, () =>
        dynamicUpdate(effectiveDb, tableName, id, finalPatch),
      );
      if (!record) return c.json({ error: 'Record not found' }, 404);
      await afterWrite(effectiveDb, {
        collection,
        recordId: id,
        action: 'update',
        data: record,
        userId: user.id,
        tenantId: getTenantId(c),
      });
      const serialized: Record<string, unknown> = await serializeRecord(record, collectionDef);
      return c.json(serialized);
    });
    return result as Response;
  });

  // ── PATCH /:collection/:id — Partial update ───────────────────────
  app.patch('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');

    if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

    if (!(await checkAccess(db, user, collection, 'update'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Virtual collection: proxy patch to external API
    const virtualConfigPatch = await getVirtualConfig(db, collection);
    if (virtualConfigPatch) {
      try {
        const body = await c.req.json();
        const record = await virtualUpdate(virtualConfigPatch, id, body);
        return c.json({ record });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    if (!collectionDef) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(collection);
    const body = await c.req.json();

    const { errors, processed } = await processInput(body, collectionDef, true);
    if (errors.length > 0) return c.json({ errors }, 422);

    const colAccessPatch = await getColumnAccess(db, collection, user.role ?? 'public');
    const { data: allowedPatch, blocked: blockedPatch } = filterWritableFields(
      processed,
      colAccessPatch,
    );
    if (blockedPatch.length > 0) {
      return c.json(
        { error: `Fields are read-only for your role: ${blockedPatch.join(', ')}` },
        403,
      );
    }

    const effectiveDb = getDb(c, db);
    const toUpdate = { ...allowedPatch, updated_by: user.id };

    let beforeQuery = dynamicDb(effectiveDb).selectFrom(tableName).selectAll().where('id', '=', id);
    beforeQuery = queryAlterRegistry.applyAll(beforeQuery, tableName, user);
    const beforeRow = await beforeQuery.executeTakeFirst();
    if (!beforeRow) return c.json({ error: 'Record not found' }, 404);

    if (!(await entityAccessRegistry.isAllowed(tableName, beforeRow, user, 'update'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    let finalPatch: Record<string, unknown>;
    try {
      const hooked = await engineEvents.runBefore('record.beforeUpdate', {
        collection,
        id,
        before: beforeRow,
        patch: toUpdate,
        userId: user.id,
      });
      finalPatch = hooked.patch;
    } catch (err) {
      if (err instanceof AbortHookError) {
        return c.json({ code: 'EXT_HOOK_ABORTED', reason: err.reason }, 422);
      }
      throw err;
    }

    const result = await handlePgErrors(c, async () => {
      const record = await dynamicUpdate(effectiveDb, tableName, id, finalPatch);
      if (!record) return c.json({ error: 'Record not found' }, 404);
      await afterWrite(effectiveDb, {
        collection,
        recordId: id,
        action: 'update',
        data: record,
        delta: body,
        userId: user.id,
        tenantId: getTenantId(c),
      });
      const serialized: Record<string, unknown> = await serializeRecord(record, collectionDef);
      return c.json(serialized);
    });
    return result as Response;
  });

  // ── DELETE /:collection/:id — Delete record ───────────────────────
  app.delete('/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    const user = c.get('user');

    if (!isUuid(id)) return c.json({ error: 'Record not found' }, 404);

    if (!(await checkAccess(db, user, collection, 'delete'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Virtual collection: proxy delete to external API
    const virtualConfigDelete = await getVirtualConfig(db, collection);
    if (virtualConfigDelete) {
      try {
        await virtualDelete(virtualConfigDelete, id);
        return c.json({ success: true });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Virtual source error' }, 502);
      }
    }

    if (!(await DDLManager.getCollection(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const tableName = DDLManager.getTableName(collection);
    const effectiveDb = getDb(c, db);

    // Dynamic user-created table — tableName is resolved at runtime, cannot be statically typed
    // Fetch existing for revision log, then delete atomically. Apply query
    // alters so a row hidden by an extension filter cannot be deleted by ID.
    let existingQuery = dynamicDb(effectiveDb)
      .selectFrom(tableName)
      .selectAll()
      .where('id', '=', id);
    existingQuery = queryAlterRegistry.applyAll(existingQuery, tableName, user);
    const existing = await existingQuery.executeTakeFirst();

    if (!existing) return c.json({ error: 'Record not found' }, 404);

    if (!(await entityAccessRegistry.isAllowed(tableName, existing, user, 'delete'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    try {
      await engineEvents.runBefore('record.beforeDelete', {
        collection,
        id,
        record: existing,
        userId: user.id,
      });
    } catch (err) {
      if (err instanceof AbortHookError) {
        return c.json({ code: 'EXT_HOOK_ABORTED', reason: err.reason }, 422);
      }
      throw err;
    }

    const deleted = await tracedQuery(`${tableName}.delete`, () =>
      dynamicDelete(effectiveDb, tableName, id),
    );
    if (!deleted) return c.json({ error: 'Record not found' }, 404);

    await afterWrite(effectiveDb, {
      collection,
      recordId: id,
      action: 'delete',
      data: existing,
      userId: user.id,
      tenantId: getTenantId(c),
    });

    return c.json({ success: true, id });
  });

  return app;
}
