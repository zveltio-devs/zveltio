/**
 * SDK Local-First Sync Endpoints
 *
 * POST /api/sync/push — batch of operations from client (offline writes)
 * POST /api/sync/pull — client requests changes after its cursors
 */

import { sqlState } from '../db/bun-sql-quirks.js';
import { describeWriteRefusal, isRlsRefusal } from '../lib/data/index.js';
import { guardSession } from '../lib/admin-guard.js';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { getAuth } from '../lib/auth.js';
import type { Database } from '../db/index.js';
import {
  applyRlsFilters,
  checkPermission,
  filterWritableFields,
  getColumnAccess,
  getRlsFilters,
  getSingleTenantId,
  resolveUserRole,
} from '../lib/tenancy/index.js';
import {
  DDLManager,
  afterWrite,
  processInput,
  readScope,
  rowAuthorId,
  serializeRecord,
} from '../lib/data/index.js';
import { tenantId } from '../lib/route-db.js';
import { withSavepoint } from '../lib/savepoint.js';
import { SYNC_TOMBSTONE_RETENTION_DAYS } from '../lib/runtime/index.js';

/**
 * The newest `updated_at` a pull may hand out, in epoch microseconds, as text.
 *
 * A row's `updated_at` is its transaction's `now()`: when the transaction
 * STARTED (the column default on insert, the touch trigger on update; sync push
 * and `dynamicInsert` strip a client-supplied value). A transaction still open
 * can therefore commit rows older than anything a pull has already returned,
 * and a client whose cursor had moved past them never
 * received them. Every row older than the oldest open transaction's start is
 * final, so a pull delivers only those.
 *
 * Read on `pool`, as the engine's own login role: inside the tenant transaction
 * the role is `zveltio_rls`, which sees `xact_start` of no session but its own.
 * `ownPid` is the pull's transaction, whose own writes it sees anyway.
 * `statement_timestamp()` bounds the rest: a transaction starting now is newer.
 *
 * `0` — deliver nothing, move nothing — when a session this role may not
 * inspect (another role, without pg_read_all_stats) is inside a transaction,
 * or a prepared transaction exists: either may hold rows of any age.
 *
 * ponytail: a backend between reading its first statement and reporting its
 * transaction start is invisible here for microseconds; a transaction that
 * old at the statement start below is not covered.
 */
export async function syncWatermarkUs(pool: Database, ownPid: number): Promise<string> {
  const { rows } = await sql<{ w: string }>`
    SELECT CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_stat_activity a
        JOIN pg_locks l ON l.pid = a.pid AND l.locktype = 'virtualxid'
        WHERE a.datname = current_database() AND a.backend_type IS NULL
          AND a.pid NOT IN (pg_backend_pid(), ${ownPid})
      ) OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database = current_database())
      THEN 0
      ELSE (extract(epoch FROM least(statement_timestamp(), (
        SELECT min(xact_start) FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend'
          AND pid NOT IN (pg_backend_pid(), ${ownPid})
      ))) * 1000000)::bigint
    END::text AS w
  `.execute(pool);
  return rows[0]!.w;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function syncRoutes(db: Database, _auth: any, poolDb: Database): Hono {
  const app = new Hono();
  const auth = getAuth();

  // Auth middleware for all /sync routes
  app.use('*', async (c, next) => {
    const session = await guardSession(c, auth);
    if (session instanceof Response) return session;
    // The REAL role, resolved from the database. `session.user.role` is always
    // undefined (not declared in better-auth's additionalFields), and this line
    // used to fabricate `'user'` — a role name that exists nowhere else in the
    // system, so every column permission and RLS role match silently missed.
    // Three routes invented three different defaults for the same absent field:
    // `'public'` in the data handlers, `'member'` in rpc, `'user'` here.
    c.set('user', { ...session.user, role: await resolveUserRole(session.user) });
    await next();
  });

  // System fields that clients must never be allowed to overwrite via sync.
  const PROTECTED_FIELDS = new Set([
    'id',
    'created_at',
    'created_by',
    'updated_at',
    'tenant_id',
    'search_vector',
    'embedding',
  ]);

  /**
   * Strips protected system fields from a sync payload and validates that the
   * remaining keys are known columns in the collection schema.
   * Returns { safe: true, payload } or { safe: false, reason }.
   */
  async function sanitizeSyncPayload(
    collectionName: string,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    raw: Record<string, any>,
    actor: { id: string; role: string },
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  ): Promise<{ safe: true; payload: Record<string, any> } | { safe: false; reason: string }> {
    const collectionDef = await DDLManager.getCollection(db, collectionName.replace(/^zvd_/, ''));
    if (!collectionDef) {
      return {
        safe: false,
        reason: `Collection "${collectionName}" not found`,
      };
    }

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const allowedFields = new Set((collectionDef.fields as any[]).map((f: any) => f.name));

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const payload: Record<string, any> = {};
    for (const [key, value] of Object.entries(raw || {})) {
      if (PROTECTED_FIELDS.has(key)) continue; // silently strip system fields
      if (!allowedFields.has(key)) {
        return {
          safe: false,
          reason: `Unknown field "${key}" in collection "${collectionName}"`,
        };
      }
      payload[key] = value;
    }

    // Run the same field pipeline the API write path uses.
    //
    // Sanitizing stopped at the column allowlist: it kept a client from
    // writing `role` or `tenant_id`, then handed the values straight to the
    // INSERT. So a field type's `deserialize` never ran and `encrypted: true`
    // was ignored — a password pushed by an offline client was stored as
    // plaintext, and a column that is encrypted through every other path was
    // not encrypted through this one. Sync is the path that runs unattended.
    //
    // `partial: true` because a sync operation carries only the columns the
    // client actually changed.
    const { errors, processed } = await processInput(payload, collectionDef, true);
    if (errors.length > 0) {
      return { safe: false, reason: errors.join('; ') };
    }

    // Column-level WRITE permissions, the same check `/api/data` makes.
    //
    // Sanitizing covered the column allowlist and the field pipeline and
    // stopped there. Measured: a member for whom `salary` is `can_write: false`
    // got 403 from `PATCH /api/data/<coll>/<id>` and wrote the same column
    // through `POST /api/sync/push`. Pull already applies `getColumnAccess`
    // (see below) — only the write half was missing.
    const writeAccess = await getColumnAccess(
      db,
      collectionName.replace(/^zvd_/, ''),
      actor.role,
      actor.id,
    );
    const { data: writable, blocked } = filterWritableFields(processed, writeAccess);
    if (blocked.length > 0) {
      return { safe: false, reason: `Fields are read-only for your role: ${blocked.join(', ')}` };
    }

    return { safe: true, payload: writable };
  }

  /**
   * POST /api/sync/push
   * Receives batch of operations from client (local writes made offline).
   * Body: { operations: [{ collection, recordId, operation, payload, clientTimestamp }] }
   * Response: { results: [{ recordId, status: 'ok' | 'conflict' | 'error', serverVersion, serverData? }] }
   */
  app.post('/push', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.operations)) {
      return c.json({ error: 'Invalid body: expected { operations: [...] }' }, 400);
    }

    const { operations } = body;

    // DDoS protection: limit batch size
    if (operations.length > 500) {
      return c.json({ error: 'Batch too large. Maximum 500 operations per push.' }, 400);
    }

    const results: Array<{
      recordId: string;
      status: 'ok' | 'conflict' | 'error';
      serverVersion?: number;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      serverData?: any;
      error?: string;
    }> = [];

    // Security: only user-defined collections (zvd_ prefix) are writable via sync.
    // This prevents clients from pushing operations to system tables (user, casbin_rule,
    // zv_api_keys, etc.).
    const COLLECTION_RE = /^zvd_[a-z][a-z0-9_]*$/;

    // Group creates by collection for batch insert
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const createsByCollection = new Map<string, Array<{ recordId: string; payload: any }>>();
    const nonCreateOps: typeof operations = [];

    for (const op of operations) {
      if (!op.collection || !op.recordId || !op.operation) {
        results.push({
          recordId: op.recordId || 'unknown',
          status: 'error',
          error: 'Missing required fields',
        });
        continue;
      }

      // Normalize: allow short names ('orders') or full names ('zvd_orders')
      const tableName: string = op.collection.startsWith('zvd_')
        ? op.collection
        : `zvd_${op.collection}`;

      // A registered collection, not any `zvd_` table: junctions (`zvd_jnc_*`)
      // and the engine's own (`zvd_permissions`) matched the pattern.
      if (
        !COLLECTION_RE.test(tableName) ||
        !(await DDLManager.getCollection(db, tableName.slice(4)))
      ) {
        results.push({
          recordId: op.recordId,
          status: 'error',
          error: `Invalid collection name: "${op.collection}". Only user-defined collections are writable via sync.`,
        });
        continue;
      }

      // Validate operation type
      if (!['create', 'update', 'delete'].includes(op.operation)) {
        results.push({
          recordId: op.recordId,
          status: 'error',
          error: `Unknown operation: "${op.operation}". Allowed: create, update, delete.`,
        });
        continue;
      }

      // Reassign normalized table name for downstream use
      op.collection = tableName;

      // Permission check via checkPermission(), never user.role —
      // Better-Auth's session may not carry `role` on magic-link / OAuth
      // flows. checkPermission handles god bypass + Casbin in the right
      // order regardless of how the user signed in. The bare collection name,
      // as REST and realtime ask: a `data:<name>` resource no grant names was
      // met only by an instance-wide wildcard, so sync refused every user the
      // collection's own grants let read and write it.
      const collectionShortName = op.collection.replace(/^zvd_/, '');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user') as any;
      const canWrite = await checkPermission(
        user.id,
        collectionShortName,
        op.operation === 'delete' ? 'delete' : op.operation === 'create' ? 'create' : 'update',
      );
      if (!canWrite) {
        results.push({
          recordId: op.recordId,
          status: 'error',
          error: `No permission to ${op.operation} in collection "${collectionShortName}"`,
        });
        continue;
      }

      // Sanitize payload — strip system fields, validate known columns
      if (op.operation !== 'delete') {
        const sanitized = await sanitizeSyncPayload(op.collection, op.payload, {
          id: user.id,
          role: user.role,
        });
        if (!sanitized.safe) {
          results.push({
            recordId: op.recordId,
            status: 'error',
            error: sanitized.reason,
          });
          continue;
        }
        op.payload = sanitized.payload;
      }

      if (op.operation === 'create') {
        const list = createsByCollection.get(op.collection) ?? [];
        list.push({ recordId: op.recordId, payload: op.payload });
        createsByCollection.set(op.collection, list);
      } else {
        nonCreateOps.push(op);
      }
    }

    // Use tenant-isolated transaction when available (RLS enforcement)
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;

    // Batch insert per collection — single INSERT with ON CONFLICT DO NOTHING
    const now = Date.now();
    for (const [collection, creates] of createsByCollection) {
      try {
        const records = creates.map(({ recordId, payload }) => ({
          id: recordId,
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
          created_by: (c.get('user') as any).id,
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
          updated_by: (c.get('user') as any).id,
          ...payload,
        }));
        // RETURNING, because `onConflict(...).doNothing()` silently skips a row
        // whose id already exists. Without it every create was reported `ok`:
        // the client marked its offline write as synced and dropped it, the row
        // on the server still held the OLD values, and `afterWrite` below wrote
        // a revision for a write that never happened — so `?as_of=` showed a
        // version the table never had.
        // A SAVEPOINT per collection. Postgres aborts the WHOLE transaction on
        // any failed statement, and `effectiveDb` is the request's tenant
        // transaction — measured: a unique-violation on the first operation
        // made every later operation in the same push answer `25P02 current
        // transaction is aborted`, so one bad row lost the other 499 and blamed
        // them for it.
        const inserted = await withSavepoint(
          effectiveDb,
          'sync_push_create',
          () =>
            effectiveDb
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
              .insertInto(collection as any)
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
              .values(records as any)
              .onConflict((oc) => oc.column('id').doNothing())
              .returning('id')
              .execute(),
          (err) => {
            throw err;
          },
        );
        const insertedIds = new Set(inserted.map((r) => (r as { id: string }).id));
        // Post-write side effects, per row, exactly as the bulk handler does
        // for `POST /:collection/bulk` — revision history, realtime, webhooks,
        // engine events. A sync push had none of them, so a record created
        // offline appeared in the table and nowhere else: no revision (so
        // `?as_of=` could not see it), no webhook, no realtime nudge to the
        // colleague looking at the same list.
        //
        // Per row is safe here for the same reason it is safe there: a push is
        // capped at 500 operations, the same cap the bulk endpoint enforces.
        // Import is uncapped and gets different treatment.
        // AWAITED, unlike before.
        //
        // `afterWrite` fans out to event listeners, and an async listener that
        // starts inside this request but finishes after it dies on "Transaction
        // is already committed" — inside its own try/catch, so the side effect
        // just silently does not happen. That is the same defect that meant
        // `compliance/ro/efactura` had never drafted a single submission.
        //
        // Not awaiting was deliberate, for push throughput. But a push is
        // capped at 500 operations and the work is the same work the bulk
        // endpoint already awaits per row; paying for it in latency is better
        // than a sync push that writes the rows and quietly drops every
        // revision, webhook and realtime nudge that should follow them.
        const syncTid = tenantId(c);
        for (const { recordId, payload } of creates) {
          if (!insertedIds.has(recordId)) {
            // The id is already taken. `conflict` is the status the client needs
            // to re-pull and reconcile; `ok` told it to throw its copy away.
            results.push({ recordId, status: 'conflict' });
            continue;
          }
          results.push({ recordId, status: 'ok', serverVersion: now });
          await afterWrite(effectiveDb, {
            collection,
            recordId,
            action: 'create',
            data: { ...payload, id: recordId },
            userId: (c.get('user') as { id: string }).id,
            author: rowAuthorId(c.get('user') as { id: string; authorUserId?: string | null }),
            tenantId: syncTid,
          });
        }
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      } catch (err: any) {
        // The same explanation `/api/data` gives. Sync used to hand back the raw
        // Postgres string, so a row refused by a row rule read as an internal
        // error — the two paths disagreed about what had just happened.
        const explained = isRlsRefusal(err) ? describeWriteRefusal(String(err.message)) : null;
        for (const { recordId } of creates) {
          results.push({
            recordId,
            status: 'error',
            error: explained ?? err.message ?? 'Database error',
          });
        }
      }
    }

    // RLS conditions depend on the caller and the collection, not the row, so
    // resolve each collection once per push instead of per operation — a batch
    // commonly touches the same few collections many times.
    const rlsCache = new Map<string, Awaited<ReturnType<typeof getRlsFilters>>>();
    // The session user, shaped for getRlsFilters. `role` is defaulted where the
    // session is read at the top of this route, so it is always present.
    const syncUser = () => c.get('user') as { id: string; email?: string; role: string };
    const syncRlsFilters = async (coll: string) => {
      const hit = rlsCache.get(coll);
      if (hit) return hit;
      const filters = await getRlsFilters(coll, syncUser(), c.get('authType') ?? 'session');
      rlsCache.set(coll, filters);
      return filters;
    };

    // Update and delete remain sequential
    for (const op of nonCreateOps) {
      const { collection, recordId, operation, payload } = op;
      try {
        switch (operation) {
          case 'update': {
            // RLS conditions go into the WHERE, so a row the caller may not see
            // is not matched and the update is a no-op. The sync push path wrote
            // by id with no row-level check at all, which made it a way around
            // the policies the /api/data handlers enforce.
            // RETURNING again: the RLS conditions are in the WHERE, so a row the
            // caller may not touch simply does not match and the statement
            // affects nothing. Reporting `ok` for that told the client its
            // offline edit had landed on a row it is not allowed to write.
            // Same SAVEPOINT reason as the create branch above: one failed
            // statement would otherwise abort the request's transaction and
            // every later operation in the push with it.
            const updateFilters = await syncRlsFilters(collection);
            const touched = await withSavepoint(
              effectiveDb,
              'sync_push_update',
              () =>
                applyRlsFilters(
                  effectiveDb
                    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
                    .updateTable(collection as any)
                    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
                    .set({ ...payload, updated_by: syncUser().id } as any)
                    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
                    .where('id' as any, '=', recordId),
                  updateFilters,
                )
                  .returning('id')
                  .execute(),
              (err) => {
                throw err;
              },
            );
            results.push(
              touched.length > 0
                ? { recordId, status: 'ok', serverVersion: Date.now() }
                : { recordId, status: 'conflict' },
            );
            break;
          }

          case 'delete': {
            const deleteFilters = await syncRlsFilters(collection);
            const removed = await withSavepoint(
              effectiveDb,
              'sync_push_delete',
              () =>
                applyRlsFilters(
                  effectiveDb
                    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
                    .deleteFrom(collection as any)
                    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
                    .where('id' as any, '=', recordId),
                  deleteFilters,
                )
                  .returning('id')
                  .execute(),
              (err) => {
                throw err;
              },
            );
            results.push(
              removed.length > 0
                ? { recordId, status: 'ok', serverVersion: Date.now() }
                : { recordId, status: 'conflict' },
            );
            break;
          }

          default:
            results.push({
              recordId,
              status: 'error',
              error: `Unknown operation: ${operation}`,
            });
        }
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      } catch (err: any) {
        const explained = isRlsRefusal(err) ? describeWriteRefusal(String(err.message)) : null;
        results.push({
          recordId,
          status: 'error',
          error: explained ?? err.message ?? 'Database error',
        });
      }
    }

    return c.json({ results });
  });

  /**
   * POST /api/sync/pull
   * Body: { collections: ['users', 'posts'], cursors?: { zvd_posts: '…' } }
   * Response: { changes: [{ collection, id, data, operation, timestamp }],
   *             hasMore, cursors, resync }
   *
   * A collection returns at most 1000 rows per pull. `hasMore` says one
   * stopped there; `cursors` holds, per collection (keyed as `changes[].
   * collection`), an opaque position. A client pulls again with the merged
   * `cursors` until `hasMore` is false, and keeps them for the next sync. A
   * collection without a cursor is read from its start.
   *
   * The position is `(updated_at, id)`, not a timestamp: a bulk insert gives
   * every row the transaction's `now()`, and a page boundary inside those ties
   * cannot be resumed from a time. That is also why there is no `since`: a
   * timestamp-only client could not get past a page of rows in one millisecond,
   * nor say when its deletes were last complete (below). A `since` an older
   * SDK still sends is ignored.
   *
   * Only rows older than `syncWatermarkUs` go out, and no cursor passes it: a
   * transaction still open commits rows dated at its start, which a position
   * already past them would never reach.
   *
   * A deleted row comes back as `operation: 'delete'` (`data: null`), from the
   * tombstone migration 032 has every collection table write, on the same
   * keyset and under the same watermark — a tombstone is dated at its
   * transaction's start too. They are kept `SYNC_TOMBSTONE_RETENTION_DAYS`. A
   * cursor also carries where its client's deletes are complete from (the
   * watermark of its last caught-up pull); older than the retention, a purged
   * one may be missing, so the collection restarts from nothing and
   * `resync[collection]` is true — the client drops its copy before applying
   * the page. A first pull (no cursor) has nothing to delete and gets no
   * tombstones.
   *
   * Known and accepted: a tombstone carries only the id, and no row rule can
   * judge a row that is gone, so a reader of the collection learns the ids of
   * deleted rows it could not see.
   */
  app.post('/pull', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.collections)) {
      return c.json({ error: 'Invalid body: expected { collections: string[] }' }, 400);
    }

    // Limit max collections per pull request to prevent DoS
    if (body.collections.length > 20) {
      return c.json({ error: 'Too many collections. Maximum 20 per pull request.' }, 400);
    }

    const collections = body.collections as string[];

    // `d<deletes-from us>:<updated_at in epoch microseconds>:<id>`, as the
    // previous pull wrote it. Checked here, before any SQL: a bad value cast inside the tenant
    // transaction would abort it and answer 500.
    const cursorIn = new Map<string, { del: string; us: string; id: string }>();
    if (body.cursors !== undefined) {
      if (!body.cursors || typeof body.cursors !== 'object' || Array.isArray(body.cursors)) {
        return c.json({ error: 'Invalid body: cursors must be an object' }, 400);
      }
      for (const [name, value] of Object.entries(body.cursors)) {
        const m = typeof value === 'string' ? /^d(\d{1,18}):(\d{1,18}):(.+)$/s.exec(value) : null;
        if (!m) return c.json({ error: `Invalid cursor for ${name}` }, 400);
        cursorIn.set(name, { del: m[1]!, us: m[2]!, id: m[3]! });
      }
    }

    // Limit rows per collection to prevent OOM
    const PULL_LIMIT_PER_COLLECTION = 1000;
    const cursorsOut: Record<string, string> = {};
    let hasMore = false;
    const updatedUs = sql`(extract(epoch from updated_at) * 1000000)::bigint`;
    const idText = sql`id::text COLLATE "C"`;
    const changes: Array<{
      collection: string;
      id: string;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      data: any;
      operation: 'upsert' | 'delete';
      timestamp: number;
    }> = [];

    const COLLECTION_RE = /^zvd_[a-z][a-z0-9_]*$/;
    // Use tenant-isolated transaction when available (RLS enforcement)
    const pullDb = (c.get('tenantTrx') as Database | null) ?? db;
    // Read BEFORE the row queries: each takes its snapshot after this, so a
    // transaction that has ended by now is visible to them.
    // `horizon`: the oldest position whose deletes are all still kept, on the
    // clock the collector purges by.
    const { rows: own } = await sql<{ pid: number; horizon: string }>`
      SELECT pg_backend_pid() AS pid,
        (extract(epoch FROM now() - make_interval(days => ${SYNC_TOMBSTONE_RETENTION_DAYS}::int))
          * 1000000)::bigint::text AS horizon
    `.execute(pullDb);
    const watermarkUs = await syncWatermarkUs(poolDb, own[0]!.pid);
    const horizonUs = BigInt(own[0]!.horizon);
    const resync: Record<string, true> = {};
    const usToTs = (us: string) =>
      sql`('epoch'::timestamptz + ${us}::bigint * interval '1 microsecond')`;

    for (const rawName of collections) {
      const collection: string =
        typeof rawName === 'string' && rawName.startsWith('zvd_') ? rawName : `zvd_${rawName}`;

      // Registered collections only — see push.
      if (!COLLECTION_RE.test(collection)) continue;
      if (!(await DDLManager.getCollection(db, collection.slice(4)))) continue;

      // SECURITY: verify that the user has read permission on this collection
      const collectionShortName = collection.replace(/^zvd_/, '');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user') as any;
      const canRead = await checkPermission(user.id, collectionShortName, 'read');
      if (!canRead) continue; // silently skip collections the user has no access to

      // The read gate: row policies, extension alters, entity access and
      // column permissions, as `GET /api/data` applies them. `checkPermission`
      // above is collection-level and cannot see rows. Pull once applied row
      // policies and columns only, so an offline client synced — and kept on
      // the device — the rows an extension's alter or ownership rule hides.
      // The SHORT name: policies are stored against the logical collection,
      // not the physical `zvd_` table.
      //
      // Resolved and applied OUTSIDE the catch below, so a gate that fails
      // fails the pull (500, as `GET /api/data` answers). Inside it, a failed
      // policy lookup or a throwing entity check answered 200 with the
      // collection empty and an advanced cursor: the client never received
      // those rows again.
      const scope = await readScope(
        db,
        collectionShortName,
        c.get('user') as { id: string; email?: string; role: string },
        c.get('authType') ?? 'session',
      );
      let cursor = cursorIn.get(collection);
      // Judged by where this client's deletes are complete from, not by the
      // cursor's row position: paging through rows older than the retention
      // restarted from nothing on every page, so a large old collection never
      // finished its first sync.
      if (cursor && BigInt(cursor.del) < horizonUs) {
        resync[collection] = true;
        cursor = undefined;
      }
      // `tenant_id =` and `updated_at >=` let `(tenant_id, updated_at, id::text)`
      // bound the scan; the policy's `= ANY` and a row comparison on an
      // expression cannot, so an idle pull read every row the tenant has: on
      // 200 000 rows, 63 ms and 2 535 buffers against 0,08 ms and 3. The
      // equality only when the reach is one tenant (`tenantScopeId`, db/dynamic.ts).
      const tenantScopeId = getSingleTenantId();
      const pullQuery = scope.query(
        pullDb
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
          .selectFrom(collection as any)
          .selectAll()
          .select([
            sql<string>`${updatedUs}::text`.as('__zv_pull_us'),
            sql<string>`id::text`.as('__zv_pull_id'),
          ])
          .where(tenantScopeId ? sql<boolean>`tenant_id = ${tenantScopeId}` : sql<boolean>`true`)
          .where(
            cursor
              ? sql<boolean>`updated_at >= ${usToTs(cursor.us)}
                  AND (${updatedUs}, ${idText}) > (${cursor.us}::bigint, ${cursor.id})`
              : sql<boolean>`true`,
          )
          .where(sql<boolean>`updated_at < ${usToTs(watermarkUs)}`)
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
          .orderBy('updated_at' as any, 'asc')
          .orderBy(idText)
          // One past the page: tells "full" from "exactly full".
          .limit(PULL_LIMIT_PER_COLLECTION + 1),
      );
      // A collection without `updated_at` (42703) or without a table (42P01)
      // has nothing to pull — skip it. Under a savepoint, because the failed
      // statement aborts the tenant transaction: every later collection in the
      // same pull then failed too, was skipped the same way, and the client got
      // 200 with those collections empty — never receiving their rows again. Any other failure is a real one: 500.
      const fetched = await withSavepoint(
        pullDb,
        'sync_pull_collection',
        () => pullQuery.execute() as Promise<unknown[]>,
        (err) => {
          const code = sqlState(err);
          if (code === '42P01' || code === '42703') return null;
          throw err;
        },
      );
      if (!fetched) continue;
      type Row = Record<string, unknown> & { __zv_pull_us: string; __zv_pull_id: string };
      const rows = (fetched as Row[]).map((row) => ({
        us: row.__zv_pull_us,
        id: row.__zv_pull_id,
        row,
      }));
      // Deletes after the same position. `deleted_at >=` lets the index bound
      // the scan; the row comparison is the keyset (uuid order = its text's).
      const stones = !cursor
        ? []
        : (
            await sql<{ us: string; id: string }>`
                SELECT (extract(epoch FROM deleted_at) * 1000000)::bigint::text AS us,
                       row_id::text AS id
                  FROM zv_sync_tombstones
                 WHERE collection = ${collection}
                   AND deleted_at >= ${usToTs(cursor.us)}
                   AND (deleted_at, row_id::text COLLATE "C") > (${usToTs(cursor.us)}, ${cursor.id})
                   AND deleted_at < ${usToTs(watermarkUs)}
                 ORDER BY deleted_at, row_id
                 LIMIT ${PULL_LIMIT_PER_COLLECTION + 1}
              `.execute(pullDb)
          ).rows;
      // One key in both: deleted and re-inserted in one transaction. The row
      // is what exists.
      const rowKeys = new Set(rows.map((r) => `${r.us}:${r.id}`));
      const merged = [
        ...rows,
        ...stones.filter((t) => !rowKeys.has(`${t.us}:${t.id}`)).map((t) => ({ ...t, row: null })),
      ].sort((a, b) => {
        const d = BigInt(a.us) - BigInt(b.us);
        return d !== 0n ? (d < 0n ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const full = merged.length > PULL_LIMIT_PER_COLLECTION;
      const page = full ? merged.slice(0, PULL_LIMIT_PER_COLLECTION) : merged;
      // The cursor is the last row READ, not the last one kept: a row the
      // entity-access check drops below is still behind the client.
      const last = page.at(-1) ?? cursor;
      // Caught up, every tombstone below the watermark went out; a full page
      // (or a watermark of 0, which delivers nothing) still owes what it owed.
      // A client with no position holds nothing a delete could remove.
      const owed = full || watermarkUs === '0' ? (cursor?.del ?? watermarkUs) : watermarkUs;
      if (last) cursorsOut[collection] = `d${owed}:${last.us}:${last.id}`;
      if (full) hasMore = true;
      const pageRows = page.flatMap((p) => (p.row ? [p.row] : []));
      const kept = await scope.keep(
        pageRows.map(({ __zv_pull_us: _us, __zv_pull_id: _id, ...row }) => row),
      );
      const keptById = new Map(kept.map((row) => [String(row.id), row]));

      // Shape the rows the way every other read path does.
      //
      // Pull applied row policies and deleted hidden columns and stopped
      // there, which left two divergences from `GET /api/data`. Fields marked
      // `encrypted: true` went out as `enc:v1:…` — the offline client has no
      // key, so the column was simply unreadable on the device while the API
      // returned it in the clear. And the column mask was a hand-written
      // `delete` loop covering `hidden` but not `readOnly`, where
      // `applyColumnAccess` covers both.
      const pullDef = await DDLManager.getCollection(db, collectionShortName).catch(() => null);
      // In keyset order: a delete and a later re-insert of one id must apply
      // in that order.
      for (const item of page) {
        const timestamp = Math.floor(Number(item.us) / 1000);
        if (!item.row) {
          changes.push({ collection, id: item.id, data: null, operation: 'delete', timestamp });
          continue;
        }
        const record = keptById.get(item.id);
        if (!record) continue;
        const shaped = scope.shape(await serializeRecord(record, pullDef));
        changes.push({
          collection,
          id: shaped.id as string,
          data: shaped,
          operation: 'upsert',
          timestamp: new Date((record as { updated_at: string }).updated_at).getTime(),
        });
      }
    }

    return c.json({
      changes,
      hasMore,
      cursors: cursorsOut,
      resync,
    });
  });

  return app;
}
