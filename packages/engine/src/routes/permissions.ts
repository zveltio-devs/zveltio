import { Hono } from 'hono';
import { sql } from 'kysely';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

// Extend Hono's ContextVariableMap so c.set/c.get('adminUser') pass type-checking.
declare module 'hono' {
  interface ContextVariableMap {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    adminUser: any;
  }
}
import type { Database } from '../db/index.js';
import {
  checkPermission,
  getEnforcer,
  getUserRoles,
  invalidateUserPermCache,
  requireInstanceAdmin,
} from '../lib/tenancy/index.js';
import { auditLog } from '../lib/audit.js';
import { normalizeIp, rateLimit } from '../middleware/rate-limit.js';

/**
 * The settings key recording that a recovery token has been spent.
 *
 * `RECOVERY_TOKEN` is an environment variable, so the endpoint cannot unset it
 * after use — the process would have to rewrite its own configuration. What it
 * can do is remember the hash of the token it honoured, and refuse that exact
 * value from then on. The operator rotates the variable to get another use,
 * which is the property "one-time" is actually reaching for: a token that
 * leaked out of a deployment manifest or a shell history cannot be replayed.
 */
const RECOVERY_USED_KEY = 'security.recovery_token_used';

/** SHA-256 of the token, so a database reader cannot replay what they find. */
async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compare in constant time.
 *
 * `a !== b` returns as soon as two bytes differ, which leaks the length of the
 * matching prefix. Over a network that is a hard signal to exploit, but this
 * particular secret grants the god role and the fix costs one function call.
 */
function secretsMatch(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await requireInstanceAdmin(session.user.id))) return null;
  return session.user;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export function permissionsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // POST /bootstrap — Emergency endpoint: promote a user to god role.
  // Requires RECOVERY_TOKEN env var (min 32 chars). Disabled when not set.
  // Usage: curl -X POST /api/permissions/bootstrap \
  //   -H "Authorization: Bearer <RECOVERY_TOKEN>" \
  //   -d '{"email":"admin@example.com"}'
  //
  // Rate limited here rather than in routes/index.ts so the guard travels with
  // the route: this is the one endpoint on the instance that hands out the god
  // role without a session, and a limiter mounted somewhere else is a limiter
  // that a later refactor can leave behind.
  app.use(
    '/bootstrap',
    rateLimit({
      // Its own bucket. A limiter shared with other pre-auth surfaces means an
      // unrelated burst elsewhere locks recovery out — and recovery is what an
      // operator reaches for when everything else has already gone wrong.
      keyPrefix: 'recovery-bootstrap',
      max: 5,
      windowMs: 15 * 60_000,
      message: 'Too many recovery attempts. Wait 15 minutes.',
    }),
  );

  app.post('/bootstrap', async (c) => {
    // For the record only — the limiter does its own identification, including
    // the TRUSTED_PROXY handling that decides whether a forwarded header may be
    // believed at all. This is best-effort attribution in the audit trail.
    const ip = normalizeIp(c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip')) ?? null;

    /** Every refusal is logged. A failed attempt here is the attack, not noise. */
    const refuse = async (reason: string, status: 401 | 403 | 404 | 409, detail?: string) => {
      await auditLog(db, {
        type: 'permission.granted',
        resourceType: 'recovery_bootstrap',
        metadata: { outcome: 'refused', reason, ip },
      }).catch((err: Error) => {
        console.error('[permissions] audit write failed on recovery refusal:', err.message);
      });
      return c.json({ error: detail ?? reason }, status);
    };

    const recoveryToken = process.env.RECOVERY_TOKEN;
    if (!recoveryToken || recoveryToken.length < 32) {
      return refuse(
        'recovery_disabled',
        403,
        'Recovery mode is not enabled. Set RECOVERY_TOKEN (min 32 chars) to use this endpoint.',
      );
    }
    const provided = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!provided || !secretsMatch(provided, recoveryToken)) {
      return refuse('invalid_token', 401, 'Invalid recovery token');
    }

    // Spent tokens stay spent. Checked after the token matches, so an attacker
    // cannot learn from the response whether a recovery has ever been performed.
    const fingerprint = await tokenFingerprint(recoveryToken);
    const spent = await db
      .selectFrom('zv_settings')
      .select(['value'])
      .where('key', '=', RECOVERY_USED_KEY)
      .executeTakeFirst();
    const spentFingerprints = Array.isArray(spent?.value) ? (spent.value as string[]) : [];
    if (spentFingerprints.includes(fingerprint)) {
      return refuse(
        'token_already_used',
        409,
        'This recovery token has already been used. Rotate RECOVERY_TOKEN to perform another recovery.',
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const email = body?.email;
    if (!email || typeof email !== 'string') {
      return c.json({ error: 'email is required' }, 400);
    }
    const result = await db
      .updateTable('user')
      .set({ role: 'god' })
      .where('email', '=', email)
      .returning(['id', 'email', 'role'])
      .executeTakeFirst();
    if (!result) return refuse('user_not_found', 404, `No user found with email: ${email}`);

    // Spend the token before reporting success. If this write fails the grant
    // has already happened, so it must not be swallowed: a token that silently
    // stays live is the finding this is here to close.
    // `::text::jsonb`, for the reason spelled out in lib/audit.ts: a bare
    // `::jsonb` on an already-jsonb parameter stores the array as a jsonb
    // STRING, and `Array.isArray()` on the way back is then false — which would
    // silently make the token reusable, i.e. exactly the finding this closes.
    const spentJson = JSON.stringify([...spentFingerprints, fingerprint]);
    await sql`
      INSERT INTO zv_settings (key, value, description)
      VALUES (
        ${RECOVERY_USED_KEY},
        ${spentJson}::text::jsonb,
        'SHA-256 of every RECOVERY_TOKEN that has been used. Rotate to re-enable.'
      )
      ON CONFLICT (key) DO UPDATE SET value = ${spentJson}::text::jsonb, updated_at = NOW()
    `.execute(db);

    // The grant itself. This endpoint promoted a user to god and wrote nothing
    // anywhere — the single most privileged action the instance can perform was
    // the one action with no record of who did it or when.
    await auditLog(db, {
      type: 'permission.granted',
      userId: result.id,
      resourceId: result.id,
      resourceType: 'recovery_bootstrap',
      metadata: { outcome: 'granted', role: 'god', email: result.email, ip },
    }).catch((err: Error) => {
      console.error('[permissions] audit write failed after recovery grant:', err.message);
    });

    const { invalidateGodCache } = await import('../lib/tenancy/index.js');
    await invalidateGodCache(result.id).catch((err: Error) => {
      // Cache invalidation failure on a privilege grant is HIGH-IMPACT:
      // the new god role won't be visible until the cache TTL expires.
      // Logging is the minimum — operator may need to bounce the cache.
      console.error('[permissions] invalidateGodCache failed after role grant:', err.message);
    });
    return c.json({
      success: true,
      user: { id: result.id, email: result.email, role: result.role },
    });
  });

  // Store admin user in context so handlers can access it for audit logging.
  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('adminUser', user);
    await next();
  });

  // GET / — List all policies
  app.get('/', async (c) => {
    const policies = await db
      .selectFrom('zvd_permissions')
      .selectAll()
      .orderBy('ptype')
      .orderBy('v0')
      .execute();
    return c.json({ policies });
  });

  // GET /roles/:userId — Get roles for a user
  app.get('/roles/:userId', async (c) => {
    const roles = await getUserRoles(c.req.param('userId'));
    return c.json({ roles });
  });

  // POST /roles — Assign role to user
  app.post(
    '/roles',
    zValidator(
      'json',
      z.object({
        userId: z.string(),
        role: z.string(),
      }),
    ),
    async (c) => {
      const { userId, role } = c.req.valid('json');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const admin = c.get('adminUser') as any;
      const e = await getEnforcer();
      await e.addRoleForUser(userId, role, '*');
      await invalidateUserPermCache(userId);
      // F2 FIX: Audit trail for role assignment.
      auditLog(db, {
        type: 'user.role_changed',
        userId: admin?.id,
        resourceId: userId,
        resourceType: 'user',
        metadata: { action: 'role_assigned', role },
      }).catch((err: Error) => {
        // Permission/role audit must survive — if it fails, the auditor
        // loses traceability for a privilege change. Log loudly.
        console.error('[permissions] audit log failed:', err.message);
      });
      return c.json({ success: true, userId, role });
    },
  );

  // DELETE /roles — Remove role from user
  app.delete(
    '/roles',
    zValidator(
      'json',
      z.object({
        userId: z.string(),
        role: z.string(),
      }),
    ),
    async (c) => {
      const { userId, role } = c.req.valid('json');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const admin = c.get('adminUser') as any;
      const e = await getEnforcer();
      await e.deleteRoleForUser(userId, role, '*');
      await invalidateUserPermCache(userId);
      // F2 FIX: Audit trail for role removal.
      auditLog(db, {
        type: 'user.role_changed',
        userId: admin?.id,
        resourceId: userId,
        resourceType: 'user',
        metadata: { action: 'role_removed', role },
      }).catch((err: Error) => {
        // Permission/role audit must survive — if it fails, the auditor
        // loses traceability for a privilege change. Log loudly.
        console.error('[permissions] audit log failed:', err.message);
      });
      return c.json({ success: true });
    },
  );

  // POST /policies — Add a policy
  app.post(
    '/policies',
    zValidator(
      'json',
      z.object({
        subject: z.string(),
        resource: z.string(),
        action: z.string(),
      }),
    ),
    async (c) => {
      const { subject, resource, action } = c.req.valid('json');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const admin = c.get('adminUser') as any;
      const e = await getEnforcer();
      await e.addPolicy(subject, '*', resource, action);
      await invalidateAllPermissionCache();
      // F2 FIX: Audit trail for policy creation.
      auditLog(db, {
        type: 'permission.granted',
        userId: admin?.id,
        resourceType: 'policy',
        metadata: { subject, resource, effect: action },
      }).catch((err: Error) => {
        // Permission/role audit must survive — if it fails, the auditor
        // loses traceability for a privilege change. Log loudly.
        console.error('[permissions] audit log failed:', err.message);
      });
      return c.json({ success: true });
    },
  );

  // DELETE /policies — Remove a policy
  app.delete(
    '/policies',
    zValidator(
      'json',
      z.object({
        subject: z.string(),
        resource: z.string(),
        action: z.string(),
      }),
    ),
    async (c) => {
      const { subject, resource, action } = c.req.valid('json');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const admin = c.get('adminUser') as any;
      const e = await getEnforcer();
      await e.removePolicy(subject, '*', resource, action);
      await invalidateAllPermissionCache();
      // F2 FIX: Audit trail for policy removal.
      auditLog(db, {
        type: 'permission.revoked',
        userId: admin?.id,
        resourceType: 'policy',
        metadata: { subject, resource, effect: action },
      }).catch((err: Error) => {
        // Permission/role audit must survive — if it fails, the auditor
        // loses traceability for a privilege change. Log loudly.
        console.error('[permissions] audit log failed:', err.message);
      });
      return c.json({ success: true });
    },
  );

  // POST /cache/invalidate — Manual cache invalidation
  app.post('/cache/invalidate', async (c) => {
    await invalidateAllPermissionCache();
    return c.json({ success: true, message: 'Permission cache invalidated' });
  });

  return app;
}

// F2 FIX: Replace O(N) blocking KEYS command with non-blocking SCAN iteration.
// KEYS scans every key in the Redis keyspace and blocks the server for the duration —
// prohibited in production. SCAN iterates in batches without blocking.
async function invalidateAllPermissionCache() {
  const { getCache } = await import('../lib/runtime/index.js');
  const cache = getCache();
  if (!cache) return;
  try {
    const allKeys: string[] = [];
    for (const pattern of ['perm:*', 'roles:*', 'god:*', 'user:perm-keys:*']) {
      let cursor = '0';
      do {
        const [nextCursor, batch] = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        allKeys.push(...batch);
      } while (cursor !== '0');
    }
    if (allKeys.length > 0) await cache.del(...allKeys);
  } catch {
    /* cache unavailable */
  }
}
