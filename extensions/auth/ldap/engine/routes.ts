/**
 * LDAP / Active Directory auth routes
 *
 * POST /api/auth/ldap/login    — Authenticate with LDAP credentials
 * GET  /api/auth/ldap/config   — Get LDAP config (admin)
 * POST /api/auth/ldap/config   — Save LDAP config (admin)
 * POST /api/auth/ldap/test     — Test LDAP connection (admin)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { ldapAuthenticate, type LdapConfig } from './ldap-provider.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';

const LdapConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().min(1),
  bindDN: z.string().min(1),
  bindPassword: z.string().min(1),
  searchBase: z.string().min(1),
  searchFilter: z.string().default('(uid={{username}})'),
  usernameAttribute: z.string().default('uid'),
  emailAttribute: z.string().default('mail'),
  nameAttribute: z.string().default('cn'),
  tlsVerify: z.boolean().default(true),
});

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const TestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

async function requireAdmin(c: any, auth: any): Promise<any> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const isAdmin = await checkPermission(session.user.id, 'admin', '*');
  return isAdmin ? session.user : null;
}

async function getLdapConfig(db: any): Promise<z.infer<typeof LdapConfigSchema> | null> {
  try {
    const row = await db
      .selectFrom('zv_settings')
      .select('value')
      .where('key', '=', 'ldap_config')
      .executeTakeFirst();
    if (!row) return null;
    const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    return LdapConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

async function upsertLdapConfig(db: any, config: z.infer<typeof LdapConfigSchema>) {
  const value = JSON.stringify(config);
  const existing = await db
    .selectFrom('zv_settings')
    .select('key')
    .where('key', '=', 'ldap_config')
    .executeTakeFirst();

  if (existing) {
    await db.updateTable('zv_settings').set({ value, updated_at: new Date() }).where('key', '=', 'ldap_config').execute();
  } else {
    await db.insertInto('zv_settings').values({ key: 'ldap_config', value, created_at: new Date(), updated_at: new Date() }).execute();
  }
}

async function findOrCreateSsoUser(db: any, email: string, displayName: string): Promise<any> {
  const existing = await db
    .selectFrom('user')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) return existing;

  const id = crypto.randomUUID();
  await db.insertInto('user').values({
    id,
    email,
    name: displayName || email.split('@')[0],
    email_verified: true,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();

  return db.selectFrom('user').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

async function createSession(db: any, userId: string): Promise<string> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insertInto('session').values({
    id: crypto.randomUUID(),
    token,
    user_id: userId,
    expires_at: expiresAt,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
  return token;
}

export function ldapRoutes(db: any, auth: any): Hono {
  const router = new Hono();

  // POST /login — authenticate user via LDAP
  router.post('/login', zValidator('json', LoginSchema), async (c) => {
    const config = await getLdapConfig(db);
    if (!config?.enabled) return c.json({ error: 'LDAP authentication is not configured or disabled' }, 503);

    const { username, password } = c.req.valid('json');

    let ldapUser: any;
    try {
      ldapUser = await ldapAuthenticate(config as LdapConfig, username, password);
    } catch (err: any) {
      return c.json({ error: `Authentication failed: ${err.message}` }, 401);
    }

    if (!ldapUser.email) {
      return c.json({ error: 'LDAP user does not have an email address configured' }, 400);
    }

    const user = await findOrCreateSsoUser(db, ldapUser.email, ldapUser.displayName);
    const token = await createSession(db, user.id);

    return c.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  });

  // GET /config — read LDAP config (admin)
  router.get('/config', async (c) => {
    const admin = await requireAdmin(c, auth);
    if (!admin) return c.json({ error: 'Unauthorized' }, 401);

    const config = await getLdapConfig(db);
    if (config) {
      // Never expose bind password to client
      const { bindPassword: _bp, ...safe } = config;
      return c.json({ config: safe });
    }
    return c.json({ config: null });
  });

  // POST /config — save LDAP config (admin)
  router.post('/config', zValidator('json', LdapConfigSchema), async (c) => {
    const admin = await requireAdmin(c, auth);
    if (!admin) return c.json({ error: 'Unauthorized' }, 401);

    const data = c.req.valid('json');
    await upsertLdapConfig(db, data);
    return c.json({ success: true });
  });

  // POST /test — test LDAP connectivity with provided credentials (admin)
  router.post('/test', zValidator('json', TestSchema), async (c) => {
    const admin = await requireAdmin(c, auth);
    if (!admin) return c.json({ error: 'Unauthorized' }, 401);

    const config = await getLdapConfig(db);
    if (!config) return c.json({ error: 'LDAP not configured' }, 503);

    const { username, password } = c.req.valid('json');

    try {
      const user = await ldapAuthenticate(config as LdapConfig, username, password);
      return c.json({ success: true, user: { email: user.email, displayName: user.displayName } });
    } catch (err: any) {
      return c.json({ success: false, error: err.message });
    }
  });

  return router;
}
