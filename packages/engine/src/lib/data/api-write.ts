import type { Context, Hono } from 'hono';
import type { Database } from '../../db/index.js';
import type { WriteRequest } from './handlers/single.js';
import type { DataApiReadQuery as ReadQuery } from '@zveltio/sdk/extension';

export type { ReadQuery, WriteRequest };

/**
 * The data API's single-record writes — `POST`, `PATCH`, `DELETE
 * /api/data/:collection[/:id]` — for a caller that is not their route
 * (`ctx.internals`). The handlers themselves, not a second copy of their checks.
 * Loaded on first use, so the barrel keeps them out of its eager graph.
 */
export async function dataApiWrite(
  op: 'create' | 'update' | 'delete',
  c: Context,
  db: Database,
  w: WriteRequest,
): Promise<Response> {
  const h = await import('./handlers/single.js');
  const handler =
    op === 'create' ? h.createRecord : op === 'update' ? h.patchRecord : h.deleteRecord;
  return handler(c, db, w);
}

type ReadCaller = Pick<WriteRequest, 'user' | 'authType' | 'trx' | 'tenantId'>;
type ReadEnv = { Bindings: { db: Database; who: ReadCaller } };
let readApp: Promise<Hono<ReadEnv>> | undefined;

/**
 * The data API's reads — `GET /api/data/:collection[/:id]` — for a caller that
 * is not their route. The route's handlers and query validation, mounted on an
 * app of their own so the read gets a context of its own: its ETag, cache key
 * and headers are the read's, never written onto the extension's response.
 * That context holds only what `who` says — identity, transaction, tenant —
 * and nothing copied from the extension's own context, whose variables it can set.
 */
export async function dataApiRead(
  db: Database,
  who: ReadCaller,
  collection: string,
  id: string | null,
  query: ReadQuery = {},
): Promise<Response> {
  if (collection === '.' || collection === '..' || id === '.' || id === '..') {
    // A dot segment would be resolved away by the URL, reaching another route.
    return Response.json({ error: 'Record not found' }, { status: 404 });
  }
  readApp ??= (async () => {
    const [{ Hono }, { zValidator }, { QuerySchema }, list, single] = await Promise.all([
      import('hono'),
      import('@hono/zod-validator'),
      import('./query-parse.js'),
      import('./handlers/list.js'),
      import('./handlers/single.js'),
    ]);
    const app = new Hono<ReadEnv>();
    app.use('*', async (c, next) => {
      const { who } = c.env;
      c.set('user', who.user);
      c.set('authType', who.authType);
      c.set('tenantTrx', who.trx ?? null);
      // The handlers read the tenant's id alone (`getTenantId`).
      c.set('tenant', (who.tenantId ? { id: who.tenantId } : null) as never);
      await next();
    });
    app.get('/:collection', zValidator('query', QuerySchema), (c) =>
      list.listRecords(c as unknown as Context, c.env.db, c.req.valid('query')),
    );
    app.get('/:collection/:id', (c) => single.getRecord(c as unknown as Context, c.env.db));
    return app;
  })().catch((err) => {
    readApp = undefined;
    throw err;
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    qs.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const path = encodeURIComponent(collection) + (id === null ? '' : `/${encodeURIComponent(id)}`);
  const app = await readApp;
  return app.fetch(new Request(`http://data.internal/${path}?${qs}`), { db, who });
}
