import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { getEnforcer, invalidateUserPermCache } from '../lib/tenancy/index.js';
import { withAuthorizedUserCreation } from '../lib/auth.js';

// Auth routes — Better-Auth handles all /api/auth/** requests
// This file registers the handler and adds a /me convenience endpoint

/** The membership grades `zv_tenant_users.role` accepts (a CHECK constraint). */
const MEMBERSHIP_ROLES = new Set(['owner', 'admin', 'member', 'viewer']);

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function authRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // GET / — current user profile (mounted at /api/me)
  app.get('/', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Not authenticated' }, 401);

    const user = await db
      .selectFrom('user')
      .selectAll()
      .where('id', '=', session.user.id)
      .executeTakeFirst();

    return c.json({ user: user || session.user });
  });

  // PATCH / — update own profile (mounted at /api/me)
  app.patch(
    '/',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(200).optional(),
        image: z.string().url().max(2048).optional(),
      }),
    ),
    async (c) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: 'Not authenticated' }, 401);

      const { name, image } = c.req.valid('json');
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (name !== undefined) updates.name = name;
      if (image !== undefined) updates.image = image;

      await db.updateTable('user').set(updates).where('id', '=', session.user.id).execute();

      const updated = await db
        .selectFrom('user')
        .selectAll()
        .where('id', '=', session.user.id)
        .executeTakeFirst();

      return c.json({ user: updated });
    },
  );

  return app;
}

/**
 * Public invitation routes (mounted at /api/invitations).
 *
 *   GET  /api/invitations/:token       — return invite metadata if still valid
 *                                        (used by the front-end to render the
 *                                        "accept invite" form with the pre-filled
 *                                        email + role)
 *   POST /api/invitations/accept       — body: { token, password, name? }
 *                                        creates the user via Better-Auth's
 *                                        sign-up flow, then marks the invite as
 *                                        consumed. No session is created for
 *                                        the caller — the user signs in
 *                                        explicitly afterwards.
 *
 * Companion to POST /api/users/invite (admin-side) + migration 004_invitations.
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function invitationRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.get('/:token', async (c) => {
    const token = c.req.param('token');
    const invite = await db
      .selectFrom('zv_invitations')
      .select(['email', 'name', 'role', 'expires_at', 'accepted_at'])
      .where('token', '=', token)
      .executeTakeFirst();

    if (!invite) return c.json({ error: 'Invitation not found' }, 404);
    if (invite.accepted_at) return c.json({ error: 'Invitation already used' }, 410);
    if (invite.expires_at.getTime() < Date.now()) {
      return c.json({ error: 'Invitation expired' }, 410);
    }

    return c.json({
      email: invite.email,
      name: invite.name,
      role: invite.role,
      expires_at: invite.expires_at,
    });
  });

  app.post(
    '/accept',
    zValidator(
      'json',
      z.object({
        token: z.string().min(32),
        password: z.string().min(8).max(200),
        name: z.string().min(1).max(200).optional(),
      }),
    ),
    async (c) => {
      const { token, password, name: bodyName } = c.req.valid('json');

      const invite = await db
        .selectFrom('zv_invitations')
        .selectAll()
        .where('token', '=', token)
        .executeTakeFirst();

      if (!invite) return c.json({ error: 'Invitation not found' }, 404);
      if (invite.accepted_at) return c.json({ error: 'Invitation already used' }, 410);
      if (invite.expires_at.getTime() < Date.now()) {
        return c.json({ error: 'Invitation expired' }, 410);
      }

      // Sign up via Better-Auth (creates the user + an email/password account).
      // We pass headers to keep parity with normal sign-up middleware.
      // Explicitly authorized: an admin issued this invitation, so the account
      // may be created even with self-registration off. Creating a user is now
      // refused at the database hook rather than at a URL pattern, which is
      // what closed the OAuth and magic-link holes — so the paths that are
      // supposed to work have to say so.
      const result = await withAuthorizedUserCreation<{ user?: { id: string } }>(() =>
        auth.api.signUpEmail({
          body: {
            email: invite.email,
            password,
            name: bodyName ?? invite.name ?? invite.email.split('@')[0],
          },
          headers: c.req.raw.headers,
        }),
      );

      if (!result?.user) {
        return c.json({ error: 'Failed to create user' }, 500);
      }
      const userId = result.user.id;

      // Apply the invited role, join the tenant, and mark the invitation
      // consumed in one transaction so a partial failure leaves no half-state.
      await db.transaction().execute(async (trx) => {
        await trx.updateTable('user').set({ role: invite.role }).where('id', '=', userId).execute();

        // Membership in the tenant that issued the invitation.
        //
        // Accepting used to set the global role and stop there, which read as
        // "invited" everywhere in the UI while the membership gate — on by
        // default — answered 403 to every /api/* and /ext/* request the new
        // user made. `zv_invitations.tenant_id` has existed since migration
        // 021; nothing consumed it. `onConflict doNothing` so re-accepting a
        // re-issued invitation is not an error.
        //
        // `zv_tenant_users.role` is a fixed four-value membership grade, while
        // an invitation carries a Casbin role name that installs are free to
        // define. Unrecognised names join as `member`; authorization still
        // comes from the global role set above, not from this column.
        await trx
          .insertInto('zv_tenant_users')
          .values({
            tenant_id: invite.tenant_id,
            user_id: userId,
            role: MEMBERSHIP_ROLES.has(invite.role)
              ? (invite.role as 'owner' | 'admin' | 'member' | 'viewer')
              : 'member',
            invited_by: invite.invited_by,
          })
          .onConflict((oc) => oc.columns(['tenant_id', 'user_id']).doNothing())
          .execute();

        await trx
          .updateTable('zv_invitations')
          .set({ accepted_at: new Date(), accepted_by: userId })
          .where('id', '=', invite.id)
          .execute();
      });

      // Bridge to authorization in this tenant's Casbin domain, matching what
      // POST /api/tenants does for the owner it provisions. Outside the
      // transaction: a cache miss is recoverable, a rolled-back membership is
      // not.
      if (MEMBERSHIP_ROLES.has(invite.role)) {
        const e = await getEnforcer();
        await e.addRoleForUser(userId, `tenant_${invite.role}`, invite.tenant_id);
      }
      await invalidateUserPermCache(userId);

      return c.json({ success: true, user: { id: userId, email: invite.email } }, 201);
    },
  );

  return app;
}
