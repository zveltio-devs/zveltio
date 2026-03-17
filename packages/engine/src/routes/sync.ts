/**
 * SDK Local-First Sync Endpoints
 *
 * POST /api/sync/push — batch of operations from client (offline writes)
 * POST /api/sync/pull — client requests changes from a timestamp
 */

import { Hono } from 'hono';
import { getAuth } from '../lib/auth.js';
import type { Database } from '../db/index.js';

export function syncRoutes(db: Database, _auth: any): Hono {
  const app = new Hono();
  const auth = getAuth();

  // Auth middleware for all /sync routes
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });

  /**
   * POST /api/sync/push
   * Receives batch of operations from client (local writes made offline).
   * Body: { operations: [{ collection, recordId, operation, payload, clientTimestamp }] }
   * Response: { results: [{ recordId, status: 'ok' | 'conflict' | 'error', serverVersion, serverData? }] }
   */
  app.post('/push', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.operations)) {
      return c.json(
        { error: 'Invalid body: expected { operations: [...] }' },
        400,
      );
    }

    const { operations } = body;

    // DDoS protection: limit batch size
    if (operations.length > 500) {
      return c.json(
        { error: 'Batch too large. Maximum 500 operations per push.' },
        400,
      );
    }

    const results: Array<{
      recordId: string;
      status: 'ok' | 'conflict' | 'error';
      serverVersion?: number;
      serverData?: any;
      error?: string;
    }> = [];

    // Security: only user-defined collections (zvd_ prefix) are writable via sync.
    // This prevents clients from pushing operations to system tables (user, casbin_rule,
    // zv_api_keys, etc.).
    const COLLECTION_RE = /^zvd_[a-z][a-z0-9_]*$/;

    // Group creates by collection for batch insert
    const createsByCollection = new Map<
      string,
      Array<{ recordId: string; payload: any }>
    >();
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

      if (op.operation === 'create') {
        const list = createsByCollection.get(op.collection) ?? [];
        list.push({ recordId: op.recordId, payload: op.payload });
        createsByCollection.set(op.collection, list);
      } else {
        nonCreateOps.push(op);
      }
    }

    // Batch insert per collection — single INSERT with ON CONFLICT DO NOTHING
    const now = Date.now();
    for (const [collection, creates] of createsByCollection) {
      try {
        const records = creates.map(({ recordId, payload }) => ({
          id: recordId,
          ...payload,
        }));
        await db
          .insertInto(collection as any)
          .values(records as any)
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
        for (const { recordId } of creates) {
          results.push({ recordId, status: 'ok', serverVersion: now });
        }
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

    // Update and delete remain sequential
    for (const op of nonCreateOps) {
      const { collection, recordId, operation, payload } = op;
      try {
        switch (operation) {
          case 'update': {
            await db
              .updateTable(collection as any)
              .set(payload as any)
              .where('id' as any, '=', recordId)
              .execute();
            results.push({ recordId, status: 'ok', serverVersion: Date.now() });
            break;
          }

          case 'delete': {
            await db
              .deleteFrom(collection as any)
              .where('id' as any, '=', recordId)
              .execute();
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
    if (
      !body ||
      !Array.isArray(body.collections) ||
      typeof body.since !== 'number'
    ) {
      return c.json(
        {
          error:
            'Invalid body: expected { collections: string[], since: number }',
        },
        400,
      );
    }

    const { collections, since } = body as {
      collections: string[];
      since: number;
    };
    const sinceDate = new Date(since);
    const changes: Array<{
      collection: string;
      id: string;
      data: any;
      operation: 'upsert';
      timestamp: number;
    }> = [];

    const COLLECTION_RE = /^zvd_[a-z][a-z0-9_]*$/;

    for (const rawName of collections) {
      const collection: string = typeof rawName === 'string' && rawName.startsWith('zvd_')
        ? rawName
        : `zvd_${rawName}`;

      if (!COLLECTION_RE.test(collection)) continue; // skip invalid/system table names

      try {
        const updated = await db
          .selectFrom(collection as any)
          .selectAll()
          .where('updated_at' as any, '>', sinceDate)
          .execute();

        for (const record of updated) {
          const r = record as any;
          changes.push({
            collection,
            id: r.id,
            data: record,
            operation: 'upsert',
            timestamp: new Date(r.updated_at).getTime(),
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
