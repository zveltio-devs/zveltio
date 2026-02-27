import { Hono } from 'hono';
import type { Database } from '../db/index.js';

// Auth routes — Better-Auth handles all /api/auth/** requests
// This file registers the handler and adds a /me convenience endpoint

export function authRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // GET /me — current user profile
  app.get('/me', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Not authenticated' }, 401);

    const user = await db
      .selectFrom('user' as any)
      .selectAll()
      .where('id' as any, '=', session.user.id)
      .executeTakeFirst();

    return c.json({ user: user || session.user });
  });

  // PATCH /me — update own profile
  app.patch('/me', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Not authenticated' }, 401);

    const { name, image } = await c.req.json();
    const updates: Record<string, any> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (image !== undefined) updates.image = image;

    await db
      .updateTable('user' as any)
      .set(updates as any)
      .where('id' as any, '=', session.user.id)
      .execute();

    const updated = await db
      .selectFrom('user' as any)
      .selectAll()
      .where('id' as any, '=', session.user.id)
      .executeTakeFirst();

    return c.json({ user: updated });
  });

  return app;
}
