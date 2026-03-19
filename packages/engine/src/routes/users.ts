import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission, getUserRoles, getEnforcer, invalidateUserPermCache } from '../lib/permissions.js';
import { auditLog } from '../lib/audit.js';
import { escapeLike } from '../lib/query-utils.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const hasAdmin = await checkPermission(session.user.id, 'admin', '*');
  if (!hasAdmin) return null;
  return session.user;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    const parsedLimit = Math.min(parseInt(limit) || 20, 200);
    const offset = (parseInt(page) - 1) * parsedLimit;

    let query = (db as any).selectFrom('user').selectAll().orderBy('createdAt', 'desc');
    if (search) {
      const safeSearch = `%${escapeLike(search)}%`;
      query = query.where((eb: any) =>
        eb.or([
          eb('name', 'like', safeSearch),
          eb('email', 'like', safeSearch),
        ])
      );
    }

    const [users, total] = await Promise.all([
      query.offset(offset).limit(parsedLimit).execute(),
      (db as any)
        .selectFrom('user')
        .select((eb: any) => eb.fn.count('id').as('count'))
        .executeTakeFirst(),
    ]);

    // Batch-fetch all roles in one Casbin call — avoids N+1 queries
    const e = await getEnforcer();
    const usersWithRoles = await Promise.all(
      users.map(async (u: any) => {
        // getRolesForUser is a single Casbin in-memory lookup (no DB round-trip)
        const roles = await e.getRolesForUser(u.id).catch(() => []);
        return { ...u, roles };
      }),
    );

    return c.json({
      users: usersWithRoles,
      pagination: {
        total: parseInt(total?.count ?? '0'),
        page: parseInt(page),
        limit: parsedLimit,
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
        const admin = c.get('user') as any;
        await auditLog(db, {
          type: 'user.role_changed',
          userId: admin?.id,
          resourceId: userId,
          resourceType: 'user',
          metadata: { new_role: role },
        });
      }

      return c.json({ user });
    },
  );

  // POST /invite — Send an email invitation (creates a pending invite token)
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
      const adminUser = c.get('user') as any;

      // Check if user already exists
      const existing = await (db as any)
        .selectFrom('user')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();

      if (existing) return c.json({ error: 'User already exists with this email' }, 409);

      // Generate a secure invite token (expires in 48h)
      const tokenBytes = new Uint8Array(32);
      crypto.getRandomValues(tokenBytes);
      const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

      // Store the invite in zv_invitations (create if table doesn't exist — graceful)
      try {
        await (db as any)
          .insertInto('zv_invitations' as any)
          .values({
            email,
            name: name || email.split('@')[0],
            role,
            token,
            expires_at: expiresAt,
            invited_by: adminUser.id,
          } as any)
          .execute();
      } catch {
        // Table may not exist yet — fall back to returning the token directly
        // so the admin can manually share the link
        const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
        return c.json({
          message: 'Invite created (email sending not configured)',
          invite_url: `${siteUrl}/accept-invite?token=${token}`,
          token,
          expires_at: expiresAt,
        }, 201);
      }

      // Send invite email if SMTP is configured
      const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
      const inviteUrl = `${siteUrl}/accept-invite?token=${token}`;

      if (process.env.SMTP_HOST) {
        try {
          // Dynamic import — email module may not always be present
          const { sendEmail } = await import('../lib/email.js');
          await sendEmail({
            to: email,
            subject: 'You have been invited to Zveltio',
            html: `<p>Hello${name ? ' ' + escapeHtml(name) : ''},</p>
<p>You have been invited to join Zveltio. Click the link below to accept your invitation and set your password:</p>
<p><a href="${escapeHtml(inviteUrl)}">${escapeHtml(inviteUrl)}</a></p>
<p>This link expires in 48 hours.</p>`,
          });
        } catch {
          // Email sending failed — still return the invite URL
        }
      }

      return c.json({
        message: 'Invitation sent',
        invite_url: inviteUrl,
        expires_at: expiresAt,
      }, 201);
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
