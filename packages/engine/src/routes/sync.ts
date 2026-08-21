/**
 * SDK Local-First Sync Endpoints
 *
 * POST /api/sync/push — batch of operations from client (offline writes)
 * POST /api/sync/pull — client requests changes from a timestamp
 */

import { Hono } from 'hono';
import { getAuth } from '../lib/auth.js';
import type { Database } from '../db/index.js';
import {
  applyColumnAccess,
  applyRlsFilters,
  checkPermission,
  getColumnAccess,
  getRlsFilters,
  resolveUserRole,
} from '../lib/tenancy/index.js';
import { DDLManager, afterWrite, processInput, serializeRecord } from '../lib/data/index.js';
import { tenantId } from '../lib/route-db.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export function syncRoutes(db: Database, _auth: any): Hono {
  const app = new Hono();
  const auth = getAuth();

  // Auth middleware for all /sync routes
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    raw: Record<string, any>,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  ): Promise<{ safe: true; payload: Record<string, any> } | { safe: false; reason: string }> {
    const collectionDef = await DDLManager.getCollection(db, collectionName.replace(/^zvd_/, ''));
    if (!collectionDef) {
      return {
        safe: false,
        reason: `Collection "${collectionName}" not found`,
      };
    }

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const allowedFields = new Set((collectionDef.fields as any[]).map((f: any) => f.name));

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

    return { safe: true, payload: processed };
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      serverData?: any;
      error?: string;
    }> = [];

    // Security: only user-defined collections (zvd_ prefix) are writable via sync.
    // This prevents clients from pushing operations to system tables (user, casbin_rule,
    // zv_api_keys, etc.).
    const COLLECTION_RE = /^zvd_[a-z][a-z0-9_]*$/;

    // Group creates by collection for batch insert
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

      if (!COLLECTION_RE.test(tableName)) {
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
      // order regardless of how the user signed in.
      const collectionShortName = op.collection.replace(/^zvd_/, '');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const user = c.get('user') as any;
      const canWrite = await checkPermission(
        user.id,
        `data:${collectionShortName}`,
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
        const sanitized = await sanitizeSyncPayload(op.collection, op.payload);
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
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          created_by: (c.get('user') as any).id,
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          updated_by: (c.get('user') as any).id,
          ...payload,
        }));
        await effectiveDb
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          .insertInto(collection as any)
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          .values(records as any)
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
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
          results.push({ recordId, status: 'ok', serverVersion: now });
          await afterWrite(effectiveDb, {
            collection,
            recordId,
            action: 'create',
            data: { ...payload, id: recordId },
            userId: (c.get('user') as { id: string }).id,
            tenantId: syncTid,
          });
        }
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      } catch (err: any) {
        for (const { recordId } of creates) {
          results.push({
            recordId,
            status: 'error',
            error: err.message || 'Database error',
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
            await applyRlsFilters(
              effectiveDb
                // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
                .updateTable(collection as any)
                // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
                .set({ ...payload, updated_by: syncUser().id } as any)
                // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
                .where('id' as any, '=', recordId),
              await syncRlsFilters(collection),
            ).execute();
            results.push({ recordId, status: 'ok', serverVersion: Date.now() });
            break;
          }

          case 'delete': {
            await applyRlsFilters(
              effectiveDb
                // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
                .deleteFrom(collection as any)
                // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
                .where('id' as any, '=', recordId),
              await syncRlsFilters(collection),
            ).execute();
            results.push({ recordId, status: 'ok', serverVersion: Date.now() });
            break;
          }

          default:
            results.push({
              recordId,
              status: 'error',
              error: `Unknown operation: ${operation}`,
            });
        }
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      } catch (err: any) {
        results.push({
          recordId,
          status: 'error',
          error: err.message || 'Database error',
        });
      }
    }

    return c.json({ results });
  });

  /**
   * POST /api/sync/pull
   * Client requests changes from a given timestamp.
   * Body: { collections: ['users', 'posts'], since: 1709000000000 }
   * Response: { changes: [{ collection, id, data, operation, timestamp }], serverTimestamp }
   */
  app.post('/pull', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.collections) || typeof body.since !== 'number') {
      return c.json(
        {
          error: 'Invalid body: expected { collections: string[], since: number }',
        },
        400,
      );
    }

    // Limit max collections per pull request to prevent DoS
    if (body.collections.length > 20) {
      return c.json({ error: 'Too many collections. Maximum 20 per pull request.' }, 400);
    }

    const { collections, since } = body as {
      collections: string[];
      since: number;
    };

    // Limit rows per collection to prevent OOM
    const PULL_LIMIT_PER_COLLECTION = 1000;
    const sinceDate = new Date(since);
    const changes: Array<{
      collection: string;
      id: string;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      data: any;
      operation: 'upsert';
      timestamp: number;
    }> = [];

    const COLLECTION_RE = /^zvd_[a-z][a-z0-9_]*$/;
    // Use tenant-isolated transaction when available (RLS enforcement)
    const pullDb = (c.get('tenantTrx') as Database | null) ?? db;

    for (const rawName of collections) {
      const collection: string =
        typeof rawName === 'string' && rawName.startsWith('zvd_') ? rawName : `zvd_${rawName}`;

      if (!COLLECTION_RE.test(collection)) continue;

      // SECURITY: verify that the user has read permission on this collection
      const collectionShortName = collection.replace(/^zvd_/, '');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const user = c.get('user') as any;
      const canRead = await checkPermission(user.id, `data:${collectionShortName}`, 'read');
      if (!canRead) continue; // silently skip collections the user has no access to

      try {
        // Row-level security. The push path applies it (see syncRlsFilters
        // above); pull selected every changed row with none, so an offline
        // client synced exactly the rows a policy hides — and kept them on the
        // device. `checkPermission` above is collection-level and cannot see
        // rows.
        const pullRls = await getRlsFilters(
          // The SHORT name: policies are stored against the logical collection,
          // not the physical `zvd_` table.
          collectionShortName,
          c.get('user') as { id: string; email?: string; role: string },
          c.get('authType') ?? 'session',
        );
        // Column permissions likewise: `selectAll()` shipped forbidden columns.
        const pullColAccess = await getColumnAccess(db, collectionShortName, user.role);
        const pullQuery = pullDb
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          .selectFrom(collection as any)
          .selectAll()
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          .where('updated_at' as any, '>', sinceDate)
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          .orderBy('updated_at' as any, 'asc')
          .limit(PULL_LIMIT_PER_COLLECTION);
        const updated = await applyRlsFilters(pullQuery, pullRls).execute();

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
        for (const record of updated) {
          const shaped = applyColumnAccess(
            await serializeRecord(record as Record<string, unknown>, pullDef),
            pullColAccess,
          );
          changes.push({
            collection,
            id: shaped.id as string,
            data: shaped,
            operation: 'upsert',
            timestamp: new Date((record as { updated_at: string }).updated_at).getTime(),
          });
        }
      } catch {
        // Collection may not have updated_at column or may not exist — ignore
        continue;
      }
    }

    return c.json({ changes, serverTimestamp: Date.now() });
  });

  return app;
}
