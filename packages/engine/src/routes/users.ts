import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import {
  getUserRoles,
  getEnforcer,
  invalidateUserPermCache,
  getCurrentDomain,
  requireInstanceAdmin,
} from '../lib/tenancy/index.js';
import { auditLog } from '../lib/audit.js';
import { revokeAllUserSessions } from '../lib/auth.js';
import { escapeLike } from '../lib/data/index.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  // requireInstanceAdmin, NOT checkPermission(uid,'admin','*'): the tenant_admin
  // policy is ('*','*','*'), so obj='admin' matches and any delegated tenant
  // admin passed the weak check. From here they could PATCH their own row to
  // role='admin', which addRoleForUser grants in domain '*' — and the domain
  // matcher treats '*' as matching every domain, including the root tenant. That
  // is a complete escalation from tenant admin to instance owner: SQL editor,
  // Casbin policies, API keys, and deleting the god account.
  if (!(await requireInstanceAdmin(session.user.id))) return null;
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

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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

    let query = db.selectFrom('user').selectAll().orderBy('createdAt', 'desc');
    if (search) {
      const safeSearch = `%${escapeLike(search)}%`;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      query = query.where((eb: any) =>
        eb.or([eb('name', 'like', safeSearch), eb('email', 'like', safeSearch)]),
      );
    }

    const [users, total] = await Promise.all([
      query.offset(offset).limit(parsedLimit).execute(),
      db
        .selectFrom('user')
        .select((eb) => eb.fn.count('id').as('count'))
        .executeTakeFirst(),
    ]);

    // Batch-fetch all roles in one Casbin call — avoids N+1 queries
    const e = await getEnforcer();
    const usersWithRoles = await Promise.all(
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      users.map(async (u: any) => {
        // getRolesForUser is a single Casbin in-memory lookup (no DB round-trip)
        const roles = await e.getRolesForUser(u.id).catch(() => []);
        return { ...u, roles };
      }),
    );

    return c.json({
      users: usersWithRoles,
      pagination: {
        total: Number(total?.count ?? 0),
        page: parseInt(page),
        limit: parsedLimit,
      },
    });
  });

  // GET /:id — Get user by ID
  app.get('/:id', async (c) => {
    const user = await db
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
        // `god` and `member` are the only global roles this database accepts.
        //
        // Migration 052 reduced them deliberately — "all other roles (admin,
        // manager, employee, client) are Casbin-only concepts" — and migrated
        // the legacy values to `member`. The route kept offering the old
        // vocabulary, so promoting anyone to `admin` or `manager` was accepted
        // by the schema, rejected by the CHECK constraint, and surfaced as a
        // 500: a server error for what is a client sending a value that has not
        // existed for months. Matching the constraint makes it a 422, which is
        // what it always was.
        role: z.enum(['god', 'member']).optional(),
      }),
    ),
    async (c) => {
      const { name, image, role } = c.req.valid('json');
      const userId = c.req.param('id');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) updates.name = name;
      if (image !== undefined) updates.image = image;
      if (role !== undefined) updates.role = role;

      const user = await db
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
        await e.addRoleForUser(userId, role, '*');
        await invalidateUserPermCache(userId);
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
        // NOT the same `role` as the PATCH handler above, despite the name.
        //
        // That one writes `user.role`, the global column migration 052 reduced
        // to `god | member`. This one names a CASBIN role: `auth.ts` grants
        // `tenant_<role>` for the membership grades and the bare name for
        // anything else an operator has defined, and deliberately does NOT
        // write `user.role` — an earlier round fixed exactly that, because
        // assigning an invitation's role to the column made every acceptance of
        // `admin` or `manager` die on the CHECK constraint.
        //
        // Narrowing this to match the column was tried here and broke three
        // harness tests in one run: two of the three roles the product invites
        // people as stopped being invitable. Two vocabularies, one word — which
        // is the design smell the audit noted, and not something to fix by
        // quietly deleting one of them.
        role: z.enum(['admin', 'manager', 'member']).default('member'),
      }),
    ),
    async (c) => {
      const { email, name, role } = c.req.valid('json');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const adminUser = c.get('user') as any;

      // Check if user already exists
      const existing = await db
        .selectFrom('user')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();

      if (existing) return c.json({ error: 'User already exists with this email' }, 409);

      // Generate a secure invite token (expires in 48h)
      const tokenBytes = new Uint8Array(32);
      crypto.getRandomValues(tokenBytes);
      const token = Array.from(tokenBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

      // Persist invite. Migration 004 guarantees the table exists; any
      // INSERT failure here is a real DB error worth surfacing.
      await db
        .insertInto('zv_invitations')
        .values({
          email,
          name: name || email.split('@')[0],
          role,
          token,
          expires_at: expiresAt,
          invited_by: adminUser.id,
          tenant_id: getCurrentDomain(),
        })
        .execute();

      // Send invite email if SMTP is configured
      const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
      const inviteUrl = `${siteUrl}/accept-invite?token=${token}`;

      if (process.env.SMTP_HOST) {
        try {
          // Dynamic import — email module may not always be present
          // @ts-ignore — email.ts is an optional module; absence handled by catch below
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

      await auditLog(db, {
        type: 'user.invited',
        userId: adminUser.id,
        resourceId: token,
        resourceType: 'invitation',
        metadata: { email, role },
      });

      return c.json(
        {
          message: 'Invitation sent',
          invite_url: inviteUrl,
          expires_at: expiresAt,
        },
        201,
      );
    },
  );

  // DELETE /:id — Delete user
  app.delete('/:id', async (c) => {
    const userId = c.req.param('id');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const adminUser = c.get('user') as any;

    if (userId === adminUser.id) {
      return c.json({ error: 'Cannot delete your own account' }, 400);
    }

    // Sessions first, and through a helper that also clears the cache: the
    // FK cascade removes the `session` rows but not better-auth's
    // `secondaryStorage` copy, so a deleted user's cookie kept working until
    // the entry aged out of Valkey.
    await revokeAllUserSessions(db, userId);

    await db.deleteFrom('user').where('id', '=', userId).execute();

    await auditLog(db, {
      type: 'user.deleted',
      userId: adminUser.id,
      resourceId: userId,
      resourceType: 'user',
    });
    return c.json({ success: true });
  });

  return app;
}
