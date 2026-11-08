/**
 * `GET /api/actions` (ADR 0029): the extension actions the caller may run, with
 * each one's input JSON Schema — so an SDK, a Studio picker or an MCP server can
 * offer them typed. Listed only when `POST /ext/<extension>/actions/<name>` would
 * pass its checks for the same caller (`mayRunAction`), in the caller's tenant:
 * a caller learns no action it could not already run.
 *
 * A session, or an API key of this tenant: a key sees the actions its
 * `$ext:<name>` scopes and its issuer allow. No caller → 401.
 */

import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import type { SessionSource } from '../lib/admin-guard.js';
import { authenticate } from '../lib/data/index.js';
import { listRunnableActions } from '../lib/extensions/index.js';

export function actionsRoutes(db: Database, auth: SessionSource): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
    const principal = await authenticate(c, auth, db);
    if (!principal) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ actions: await listRunnableActions(c, principal.user, db) });
  });
  return app;
}
