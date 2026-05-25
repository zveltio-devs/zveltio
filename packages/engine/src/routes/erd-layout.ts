/**
 * /api/erd/layout — per-user persistent ERD positions.
 *
 *   GET    /            — current user's map of { collection_name → {x,y} }
 *   PUT    /            — replace the entire map for the current user
 *   DELETE /            — wipe the current user's positions (reset to grid)
 *
 * Auth: any signed-in user. Layouts are private to the user that wrote
 * them — there is no admin path to read someone else's, by design.
 * If teams want shared layouts later, we add `scope: 'shared' | 'private'`
 * to the table without breaking this contract.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';

const PositionsSchema = z.object({
  // Map of collection_name → position. We allow ~1000 entries which is
  // a comfortable headroom: realistic ERDs have 50–200 tables.
  positions: z.record(
    z.string().regex(/^[a-z_][a-z0-9_]*$/, 'invalid collection name'),
    z.object({
      x: z.number().finite(),
      y: z.number().finite(),
    }),
  ).refine((m) => Object.keys(m).length <= 1000, 'too many entries (max 1000)'),
});

export function erdLayoutRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth guard — every endpoint needs a signed-in user.
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  // GET / — current user's layout
  app.get('/', async (c) => {
    const user = c.get('user' as never) as any;
    const rows = await db
      .selectFrom('zv_erd_layouts')
      .select(['collection_name', 'x', 'y'])
      .where('user_id', '=', user.id)
      .execute() as Array<{ collection_name: string; x: number; y: number }>;

    const positions: Record<string, { x: number; y: number }> = {};
    for (const r of rows) positions[r.collection_name] = { x: r.x, y: r.y };
    return c.json({ positions });
  });

  // PUT / — replace the entire layout for the current user.
  //
  // We use replace-semantics (DELETE + INSERT) rather than diff-merge so
  // the client doesn't have to track deletions separately. The whole map
  // is small (~50 entries typical) so the cost is negligible.
  app.put('/', zValidator('json', PositionsSchema), async (c) => {
    const user = c.get('user' as never) as any;
    const { positions } = c.req.valid('json');

    await db.transaction().execute(async (trx: Database) => {
      await (trx as any)
        .deleteFrom('zv_erd_layouts')
        .where('user_id', '=', user.id)
        .execute();

      const entries = Object.entries(positions);
      if (entries.length > 0) {
        await (trx as any)
          .insertInto('zv_erd_layouts')
          .values(entries.map(([name, p]) => ({
            user_id: user.id,
            collection_name: name,
            x: p.x,
            y: p.y,
          })))
          .execute();
      }
    });

    return c.json({ success: true, count: Object.keys(positions).length });
  });

  // DELETE / — wipe the current user's layout
  app.delete('/', async (c) => {
    const user = c.get('user' as never) as any;
    const r = await db
      .deleteFrom('zv_erd_layouts')
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    return c.json({ success: true, deleted: Number(r?.numDeletedRows ?? 0) });
  });

  return app;
}
