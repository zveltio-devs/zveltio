import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import type { WriteRequest } from './handlers/single.js';

export type { WriteRequest };

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
