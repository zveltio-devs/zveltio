import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import {
  getUserRoles,
  getEnforcer,
  grantMemberRole,
  invalidateUserPermCache,
  getCurrentDomain,
  isGodUser,
  requireInstanceAdmin,
} from '../lib/tenancy/index.js';
import { auditLog } from '../lib/audit.js';
import { deleteUser, resetUserFactors } from '../lib/users.js';
import { asEngineRole } from '../lib/role-window.js';
import { escapeLike } from '../lib/data/index.js';
import { guardAdmin } from '../lib/admin-guard.js';
import { isEmailConfigured, sendEmail } from '../lib/email.js';
import { clientIpForAudit, hashInvitationToken } from '../lib/security/index.js';
import { mailFactorChange, requireStepUp } from '../lib/step-up.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function usersRoutes(
  db: Database,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  auth: any,
  /**
   * The raw pool, for the one statement here that must not run inside the
   * request's tenant transaction: revoking a user's sessions. Requests run as
   * `zveltio_rls`, which has had no grants on `session` since migration 044 —
   * reading a bearer token from a tenant-scoped request is what C-14 and C-10
   * did, and that stays closed. Session revocation is a platform operation.
   */
  poolDb: Database = db,
): Hono {
  const app = new Hono();

  // requireInstanceAdmin, NOT checkPermission(uid,'admin','*'): the tenant_admin
  // policy is ('*','*','*'), so obj='admin' matches and any delegated tenant
  // admin passed the weak check. From here they could PATCH their own row to
  // role='admin', which addRoleForUser grants in domain '*' — and the domain
  // matcher treats '*' as matching every domain, including the root tenant. That
  // is a complete escalation from tenant admin to instance owner: SQL editor,
  // Casbin policies, API keys, and deleting the god account.
  app.use('*', async (c, next) => {
    const user = await guardAdmin(c, auth, requireInstanceAdmin);
    if (user instanceof Response) return user;
    c.set('user', user);
    await next();
  });

  // GET / — List all users
  app.get('/', async (c) => {
    const { page = '1', limit = '20', search } = c.req.query();
    const parsedLimit = Math.min(parseInt(limit) || 20, 200);
    const offset = (parseInt(page) - 1) * parsedLimit;

    // One filtered base for the page and its total: the count used to read the
    // whole table, so a search reported every user as a match and the pager
    // offered pages of nothing.
    let base = db.selectFrom('user');
    if (search) {
      const safeSearch = `%${escapeLike(search)}%`;
      base = base.where((eb) =>
        eb.or([eb('name', 'like', safeSearch), eb('email', 'like', safeSearch)]),
      );
    }

    const [users, total] = await Promise.all([
      base.selectAll().orderBy('createdAt', 'desc').offset(offset).limit(parsedLimit).execute(),
      base.select((eb) => eb.fn.count('id').as('count')).executeTakeFirst(),
    ]);

    // Batch-fetch all roles in one Casbin call — avoids N+1 queries
    const e = await getEnforcer();
    const usersWithRoles = await Promise.all(
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      users.map(async (u: any) => {
        // getRolesForUser is a single Casbin in-memory lookup (no DB round-trip)
        // Casbin alone: `u.role` is the god attribute, not a role.
        const roles = await e.getRolesForUser(u.id).catch(() => [] as string[]);
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
      // The column is the god flag, so writing it is god-only, as the SQL
      // editor is (#951). This router admits any instance admin, and a
      // non-god admin of the root tenant sent { role: 'god' } for their own id
      // and became god, or { role: 'member' } for god's id and demoted it.
      if (role !== undefined && !(await isGodUser((c.get('user') as { id: string }).id))) {
        return c.json({ error: 'Only a god user may change a global role' }, 403);
      }
      // God status moves only through recovery (/api/permissions/bootstrap).
      // Promoting anyone collides with the one god seat (migration 008), and a
      // god demoting itself by mistake left the instance with no god at all.
      if (role !== undefined && (role === 'god') !== (await isGodUser(userId))) {
        return c.json(
          { error: 'God status changes only through recovery (/api/permissions/bootstrap)' },
          409,
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) updates.name = name;
      if (image !== undefined) updates.image = image;
      if (role !== undefined) updates.role = role;

      const user = await asEngineRole(db, () =>
        db
          .updateTable('user')
          .set(updates)
          .where('id', '=', userId)
          .returningAll()
          .executeTakeFirst(),
      );

      if (!user) return c.json({ error: 'User not found' }, 404);

      if (role) {
        // `god` is the column alone (no Casbin role); a `member` holds the
        // Casbin baseline row, so a demoted god gets it back. Nothing else is
        // touched — business roles (`employee`, …) stay.
        if (role === 'member') await grantMemberRole(userId);
        await invalidateUserPermCache(userId);
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
        const admin = c.get('user') as any;
        await auditLog(db, {
          type: 'user.role_changed',
          tenantId: null,
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const adminUser = c.get('user') as any;

      // Check if user already exists — in any case, as the unique index compares.
      const existing = await db
        .selectFrom('user')
        .select('id')
        .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
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
      // INSERT failure here is a real DB error worth surfacing. Only the digest
      // is stored: the raw token is a credential, and lives only in the link.
      const invite = await db
        .insertInto('zv_invitations')
        .values({
          email,
          name: name || email.split('@')[0],
          role,
          token: hashInvitationToken(token),
          expires_at: expiresAt,
          invited_by: adminUser.id,
          tenant_id: getCurrentDomain(),
        })
        .returning(['id', 'tenant_id'])
        .executeTakeFirstOrThrow();

      // Send invite email if SMTP is configured
      const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
      const inviteUrl = `${siteUrl}/accept-invite?token=${token}`;

      let emailSent = false;
      if (isEmailConfigured()) {
        try {
          await sendEmail({
            to: email,
            subject: 'You have been invited to Zveltio',
            html: `<p>Hello${name ? ' ' + escapeHtml(name) : ''},</p>
<p>You have been invited to join Zveltio. Click the link below to accept your invitation and set your password:</p>
<p><a href="${escapeHtml(inviteUrl)}">${escapeHtml(inviteUrl)}</a></p>
<p>This link expires in 48 hours.</p>`,
          });
          emailSent = true;
        } catch (err) {
          // The invitation exists either way — the admin can hand over invite_url.
          console.warn('[users] invite email failed:', err instanceof Error ? err.message : err);
        }
      }

      await auditLog(db, {
        type: 'user.invited',
        tenantId: invite.tenant_id,
        userId: adminUser.id,
        resourceId: invite.id,
        resourceType: 'invitation',
        metadata: { email, role },
      });

      return c.json(
        {
          message: emailSent ? 'Invitation sent' : 'Invitation created',
          email_sent: emailSent,
          invite_url: inviteUrl,
          expires_at: expiresAt,
        },
        201,
      );
    },
  );

  // POST /:id/factors/reset — clear a user's passkeys and TOTP, for one who lost them.
  app.post('/:id/factors/reset', async (c) => {
    const targetId = c.req.param('id');
    const actorId = (c.get('user') as { id: string }).id;
    const target = await db
      .selectFrom('user')
      .select(['id', 'email'])
      .where('id', '=', targetId)
      .executeTakeFirst();
    if (!target) return c.json({ error: 'User not found' }, 404);
    if (targetId === actorId) {
      return c.json(
        { error: 'Your own sign-in methods are reset through recovery (RECOVERY_TOKEN)' },
        403,
      );
    }
    // A non-god admin resets ordinary users only: else any admin could strip
    // another's (or god's) factors and enroll the next first factor themselves.
    if (!(await isGodUser(actorId)) && (await requireInstanceAdmin(targetId))) {
      return c.json({ error: 'Only god may reset an administrator' }, 403);
    }
    const confirmedBy = await requireStepUp(c, `user.factors.reset:${targetId}`);
    if (confirmedBy instanceof Response) return confirmedBy;

    const cleared = await resetUserFactors(db, poolDb, targetId);
    await auditLog(db, {
      type: 'auth.factor_changed',
      tenantId: null,
      userId: actorId,
      resourceId: targetId,
      resourceType: 'auth_factor',
      metadata: { change: 'admin.reset', confirmed_by: confirmedBy, ...cleared },
      ip: clientIpForAudit(c) ?? undefined,
    });
    mailFactorChange(
      target.email,
      'An administrator reset the passkeys and authenticator app on your account. Add one again in your security settings.',
    );
    return c.json({ success: true, ...cleared });
  });

  // DELETE /:id — Delete user
  app.delete('/:id', async (c) => {
    const userId = c.req.param('id');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const adminUser = c.get('user') as any;

    if (userId === adminUser.id) {
      return c.json({ error: 'Cannot delete your own account' }, 400);
    }

    // One helper for every way a user row goes — SCIM and GDPR erasure call it
    // too. It checks the id first (a role name sits in the same Casbin column),
    // then revokes sessions on `poolDb` (DB and cache), drops the grants, deletes
    // the row and audits `user.deleted`. See `lib/users.ts`.
    const deleted = await deleteUser(db, poolDb, userId, {
      actorUserId: adminUser.id,
      reason: 'admin',
    });
    if (!deleted) return c.json({ error: 'User not found' }, 404);
    return c.json({ success: true });
  });

  return app;
}
