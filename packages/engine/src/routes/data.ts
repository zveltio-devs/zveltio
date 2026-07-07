import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Database } from '../db/index.js';
import type { RequestUser } from '../lib/data/types.js';
import { authenticate } from '../lib/data/auth.js';
import { QuerySchema } from '../lib/data/query-parse.js';
import { listRecords } from '../lib/data/handlers/list.js';
import { bulkCreate, bulkUpdate, bulkDelete } from '../lib/data/handlers/bulk.js';
import {
  getRecord,
  createRecord,
  replaceRecord,
  patchRecord,
  deleteRecord,
} from '../lib/data/handlers/single.js';

export type { RequestUser };

declare module 'hono' {
  interface ContextVariableMap {
    user: RequestUser;
    authType: 'session' | 'api_key';
  }
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

  // ── Routes ───────────────────────────────────────────────────────
  // Handlers live in `lib/data/handlers/*` (H-05 split). Each takes
  // `(c, db)` — the list handler additionally receives the validated query
  // so the `zValidator('query', …)` middleware stays on the route. Order
  // matters: the `/bulk` collection routes MUST precede `/:collection/:id`.

  // GET /:collection — List records
  app.get('/:collection', zValidator('query', QuerySchema), (c) =>
    listRecords(c, db, c.req.valid('query')),
  );

  // Bulk collection routes (must be before /:collection/:id)
  app.post('/:collection/bulk', (c) => bulkCreate(c, db));
  app.patch('/:collection/bulk', (c) => bulkUpdate(c, db));
  app.delete('/:collection/bulk', (c) => bulkDelete(c, db));

  // Single-record routes
  app.get('/:collection/:id', (c) => getRecord(c, db));
  app.post('/:collection', (c) => createRecord(c, db));
  app.put('/:collection/:id', (c) => replaceRecord(c, db));
  app.patch('/:collection/:id', (c) => patchRecord(c, db));
  app.delete('/:collection/:id', (c) => deleteRecord(c, db));

  return app;
}
