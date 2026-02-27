import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission, getUserRoles, getEnforcer, invalidateUserPermCache } from '../lib/permissions.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const hasAdmin = await checkPermission(session.user.id, 'admin', '*');
  if (!hasAdmin) return null;
  return session.user;
}

export function usersRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET / — List all users
  app.get('/', async (c) => {
    const { page = '1', limit = '20', search } = c.req.query();
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = (db as any).selectFrom('user').selectAll().orderBy('createdAt', 'desc');
    if (search) {
      query = query.where((eb: any) =>
        eb.or([
          eb('name', 'like', `%${search}%`),
          eb('email', 'like', `%${search}%`),
        ])
      );
    }

    const users = await query.offset(offset).limit(parseInt(limit)).execute();
    const total = await (db as any)
      .selectFrom('user')
      .select((eb: any) => eb.fn.count('id').as('count'))
      .executeTakeFirst();

    // Attach roles
    const usersWithRoles = await Promise.all(
      users.map(async (u: any) => ({
        ...u,
        roles: await getUserRoles(u.id),
      })),
    );

    return c.json({
      users: usersWithRoles,
      pagination: {
        total: parseInt(total?.count ?? '0'),
        page: parseInt(page),
        limit: parseInt(limit),
      },
    });
  });

  // GET /:id — Get user by ID
  app.get('/:id', async (c) => {
    const user = await (db as any)
      .selectFrom('user')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!user) return c.json({ error: 'User not found' }, 404);

    const roles = await getUserRoles(user.id);
    return c.json({ user: { ...user, roles } });
  });

  // PATCH /:id — Update user (name, image, role)
  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().optional(),
        image: z.string().optional(),
        role: z.enum(['admin', 'manager', 'member']).optional(),
      }),
    ),
    async (c) => {
      const { name, image, role } = c.req.valid('json');
      const userId = c.req.param('id');
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) updates.name = name;
      if (image !== undefined) updates.image = image;
      if (role !== undefined) updates.role = role;

      const user = await (db as any)
        .updateTable('user')
        .set(updates)
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirst();

      if (!user) return c.json({ error: 'User not found' }, 404);

      // Update Casbin role if changed
      if (role) {
        const e = await getEnforcer();
        await e.deleteRolesForUser(userId);
        await e.addRoleForUser(userId, role);
        await invalidateUserPermCache(userId);
      }

      return c.json({ user });
    },
  );

  // POST /invite — Create user account (admin invite)
  app.post(
    '/invite',
    zValidator(
      'json',
      z.object({
        email: z.string().email(),
        name: z.string().optional(),
        role: z.enum(['admin', 'manager', 'member']).default('member'),
      }),
    ),
    async (c) => {
      const { email, name, role } = c.req.valid('json');

      // Check if user already exists
      const existing = await (db as any)
        .selectFrom('user')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();

      if (existing) return c.json({ error: 'User already exists with this email' }, 409);

      const id = crypto.randomUUID();
      const now = new Date();
      const user = await (db as any)
        .insertInto('user')
        .values({
          id,
          email,
          name: name || email.split('@')[0],
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirst();

      // Assign role in Casbin
      const e = await getEnforcer();
      await e.addRoleForUser(id, role);

      return c.json({ user }, 201);
    },
  );

  // DELETE /:id — Delete user
  app.delete('/:id', async (c) => {
    const userId = c.req.param('id');
    const adminUser = c.get('user') as any;

    if (userId === adminUser.id) {
      return c.json({ error: 'Cannot delete your own account' }, 400);
    }

    await (db as any).deleteFrom('user').where('id', '=', userId).execute();
    return c.json({ success: true });
  });

  return app;
}
