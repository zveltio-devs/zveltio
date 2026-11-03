import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Database } from '../db/index.js';
import type { RequestUser } from '../lib/data/types.js';
import { authenticate } from '../lib/data/auth.js';
import { hasSessionCookie, sessionCookieName } from '../middleware/session-prefetch.js';
import { ANONYMOUS_SUBJECT } from '../lib/tenancy/index.js';
import { anonymousReadRateLimit } from '../middleware/rate-limit.js';
import { QuerySchema } from '../lib/data/query-parse.js';
import { listRecords } from '../lib/data/handlers/list.js';
import { listReadableCollections } from '../lib/data/handlers/collections.js';
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
    authType: 'session' | 'api_key' | 'anonymous';
  }
}

// biome-ignore lint/suspicious/noExplicitAny: better-auth instance — no exported type, mirrors the loader's documented survivor; tracked in hardening plan item H-05
export function dataRoutes(db: Database, auth: any): Hono {
  const app = new Hono();
  const cookieName = sessionCookieName(auth?.options);

  // Auth middleware
  app.use('*', async (c, next) => {
    const result = await authenticate(c, auth, db);
    if (result) {
      c.set('user', result.user);
      c.set('authType', result.authType as 'session' | 'api_key');
      return next();
    }
    // No caller: a read runs as the tenant's `public` role, held to its grants,
    // row rules and column permissions like any role (ADR 0017); it has none
    // until an operator grants them. Never a write, never without the tenant
    // transaction that publishes that identity to the database, and never for a
    // request that presented a credential: a refused key, a signed-out or forged
    // session cookie, or any Authorization header is a 401, not a visitor — the
    // SDK sends its client to sign in only on a 401.
    const read = c.req.method === 'GET' || c.req.method === 'HEAD';
    const credentialPresented =
      !!c.req.header('authorization') ||
      !!c.req.header('x-api-key') ||
      hasSessionCookie(c.req.raw.headers, cookieName);
    if (!read || credentialPresented || !c.get('tenantTrx')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const limited = await anonymousReadRateLimit(c, async () => undefined);
    if (limited) return limited;
    c.set('user', { id: ANONYMOUS_SUBJECT, name: 'anonymous', role: ANONYMOUS_SUBJECT });
    c.set('authType', 'anonymous');
    await next();
  });

  // ── Routes ───────────────────────────────────────────────────────
  // Handlers live in `lib/data/handlers/*` (H-05 split). Each takes
  // `(c, db)` — the list handler additionally receives the validated query
  // so the `zValidator('query', …)` middleware stays on the route. Order
  // matters: the `/bulk` collection routes MUST precede `/:collection/:id`.

  // GET / — the collections the caller may read, with the fields they may see
  app.get('/', (c) => listReadableCollections(c, db));

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
