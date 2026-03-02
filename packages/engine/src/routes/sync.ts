/**
 * SDK Local-First Sync Endpoints
 *
 * POST /api/sync/push — batch de operații de la client (offline writes)
 * POST /api/sync/pull — client cere changes de la un timestamp
 *
 * NOTA PERFORMANȚĂ: Bucla secvențială din /push e OK pentru MVP.
 * La v2.1, refactorizează în batch upsert (INSERT INTO ... ON CONFLICT)
 * grupat pe colecție, pentru a gestiona eficient batch-uri de 500+ operații.
 */

import { Hono } from 'hono';
import { auth } from '../lib/auth.js';
import type { Database } from '../db/index.js';

export function syncRoutes(db: Database, _auth: any): Hono {
  const app = new Hono();

  // Auth middleware pentru toate rutele /sync
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  /**
   * POST /api/sync/push
   * Primește batch de operații de la client (local writes făcute offline).
   * Body: { operations: [{ collection, recordId, operation, payload, clientTimestamp }] }
   * Response: { results: [{ recordId, status: 'ok' | 'conflict' | 'error', serverVersion, serverData? }] }
   */
  app.post('/push', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.operations)) {
      return c.json({ error: 'Invalid body: expected { operations: [...] }' }, 400);
    }

    const { operations } = body;
    const results: Array<{
      recordId: string;
      status: 'ok' | 'conflict' | 'error';
      serverVersion?: number;
      serverData?: any;
      error?: string;
    }> = [];

    for (const op of operations) {
      const { collection, recordId, operation, payload } = op;

      if (!collection || !recordId || !operation) {
        results.push({ recordId: recordId || 'unknown', status: 'error', error: 'Missing required fields' });
        continue;
      }

      try {
        switch (operation) {
          case 'create': {
            const existing = await db
              .selectFrom(collection as any)
              .selectAll()
              .where('id' as any, '=', recordId)
              .executeTakeFirst();

            if (existing) {
              results.push({
                recordId,
                status: 'conflict',
                serverVersion: Date.now(),
                serverData: existing,
              });
            } else {
              await db
                .insertInto(collection as any)
                .values({ id: recordId, ...payload } as any)
                .execute();
              results.push({ recordId, status: 'ok', serverVersion: Date.now() });
            }
            break;
          }

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
            results.push({ recordId, status: 'error', error: `Unknown operation: ${operation}` });
        }
      } catch (err: any) {
        results.push({ recordId, status: 'error', error: err.message || 'Database error' });
      }
    }

    return c.json({ results });
  });

  /**
   * POST /api/sync/pull
   * Client cere changes de la un timestamp dat.
   * Body: { collections: ['users', 'posts'], since: 1709000000000 }
   * Response: { changes: [{ collection, id, data, operation, timestamp }], serverTimestamp }
   */
  app.post('/pull', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.collections) || typeof body.since !== 'number') {
      return c.json({ error: 'Invalid body: expected { collections: string[], since: number }' }, 400);
    }

    const { collections, since } = body as { collections: string[]; since: number };
    const sinceDate = new Date(since);
    const changes: Array<{
      collection: string;
      id: string;
      data: any;
      operation: 'upsert';
      timestamp: number;
    }> = [];

    for (const collection of collections) {
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
        // Colecția poate să nu aibă coloana updated_at sau să nu existe — ignorăm
        continue;
      }
    }

    return c.json({ changes, serverTimestamp: Date.now() });
  });

  return app;
}
