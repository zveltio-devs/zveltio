/**
 * SAML 2.0 SSO routes
 *
 * GET  /api/auth/saml/login          — Redirect to IdP login page
 * POST /api/auth/saml/callback       — ACS endpoint; processes SAMLResponse
 * GET  /api/auth/saml/metadata       — SP metadata XML (register in IdP)
 * GET  /api/auth/saml/config         — Get current IdP config (admin)
 * POST /api/auth/saml/config         — Save IdP config (admin)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createSamlInstance, validateSamlResponse } from './saml-provider.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';

// Config schema stored in zv_settings key "saml_config"
const SamlConfigSchema = z.object({
  enabled: z.boolean().default(false),
  entryPoint: z.string().url('Must be a valid IdP SSO URL'),
  issuer: z.string().min(1, 'Issuer (SP Entity ID) is required'),
  cert: z.string().min(1, 'IdP certificate is required'),
  callbackUrl: z.string().url('Must be a valid ACS URL'),
  privateKey: z.string().optional(),
  signatureAlgorithm: z.enum(['sha1', 'sha256', 'sha512']).default('sha256'),
  wantAuthnResponseSigned: z.boolean().default(true),
  mapEmail: z.string().default('email'),
  mapName: z.string().default('displayName'),
});

async function requireAdmin(c: any, auth: any): Promise<any> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const isAdmin = await checkPermission(session.user.id, 'admin', '*');
  return isAdmin ? session.user : null;
}

async function getSamlConfig(db: any): Promise<z.infer<typeof SamlConfigSchema> | null> {
  try {
    const row = await db
      .selectFrom('zv_settings')
      .select('value')
      .where('key', '=', 'saml_config')
      .executeTakeFirst();
    if (!row) return null;
    const raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    return SamlConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

async function upsertSamlConfig(db: any, config: z.infer<typeof SamlConfigSchema>) {
  const value = JSON.stringify(config);
  // Try update first, then insert
  const existing = await db
    .selectFrom('zv_settings')
    .select('key')
    .where('key', '=', 'saml_config')
    .executeTakeFirst();

  if (existing) {
    await db.updateTable('zv_settings').set({ value, updated_at: new Date() }).where('key', '=', 'saml_config').execute();
  } else {
    await db.insertInto('zv_settings').values({ key: 'saml_config', value, created_at: new Date(), updated_at: new Date() }).execute();
  }
}

// Find or create a user by email (for SSO sign-in)
async function findOrCreateSsoUser(db: any, email: string, displayName: string): Promise<any> {
  const existing = await db
    .selectFrom('user')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) return existing;

  // Create new user with random password (SSO users don't use password login)
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
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
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

export function samlRoutes(db: any, auth: any): Hono {
  const router = new Hono();

  // GET /login — redirect user to IdP
  router.get('/login', async (c) => {
    const config = await getSamlConfig(db);
    if (!config?.enabled) return c.json({ error: 'SAML SSO is not configured or disabled' }, 503);

    const saml = await createSamlInstance(config);
    const rawRelayState = c.req.query('redirect') ?? '/admin';
    const relayState = rawRelayState.startsWith('/') && !rawRelayState.startsWith('//')
      ? rawRelayState
      : '/admin';
    const loginUrl = await saml.getAuthorizeUrlAsync('', c.req.raw.headers.get('host') ?? '', { RelayState: relayState });
    return c.redirect(loginUrl);
  });

  // POST /callback — ACS endpoint (IdP posts here)
  router.post('/callback', async (c) => {
    const config = await getSamlConfig(db);
    if (!config?.enabled) return c.json({ error: 'SAML SSO is not configured or disabled' }, 503);

    let body: Record<string, string>;
    try {
      const formData = await c.req.formData();
      body = Object.fromEntries(formData.entries()) as Record<string, string>;
    } catch {
      return c.json({ error: 'Invalid form data in SAML callback' }, 400);
    }

    if (!body.SAMLResponse) return c.json({ error: 'Missing SAMLResponse' }, 400);

    let profile: any;
    try {
      const saml = await createSamlInstance(config);
      profile = await validateSamlResponse(saml, body);
    } catch (err: any) {
      return c.json({ error: `SAML validation failed: ${err.message}` }, 401);
    }

    const email = profile[config.mapEmail] ?? profile.email ?? profile.nameID;
    const name = profile[config.mapName] ?? profile.displayName ?? email;

    if (!email) return c.json({ error: 'IdP did not return an email address' }, 400);

    const user = await findOrCreateSsoUser(db, email, name);
    const token = await createSession(db, user.id);

    // Validare open redirect: permite doar path-uri relative (încep cu /)
    const rawRedirect = body.RelayState ?? '/admin';
    const redirectTo = typeof rawRedirect === 'string' &&
      rawRedirect.startsWith('/') &&
      !rawRedirect.startsWith('//')  // previne protocol-relative URLs
      ? rawRedirect
      : '/admin';

    const response = c.redirect(redirectTo, 302);
    response.headers.set('Set-Cookie', `better-auth.session_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
    return response;
  });

  // GET /metadata — SP metadata XML for IdP registration
  router.get('/metadata', async (c) => {
    const config = await getSamlConfig(db);
    if (!config) return c.json({ error: 'SAML not configured' }, 503);

    const saml = await createSamlInstance(config);
    const xml: string = await saml.generateServiceProviderMetadata(
      config.privateKey ?? null,
      null,
    );

    c.header('Content-Type', 'application/xml');
    return c.body(xml);
  });

  // GET /config — read config (admin)
  router.get('/config', async (c) => {
    const admin = await requireAdmin(c, auth);
    if (!admin) return c.json({ error: 'Unauthorized' }, 401);

    const config = await getSamlConfig(db);
    // Never return private key to client
    if (config) {
      const { privateKey: _pk, ...safe } = config;
      return c.json({ config: safe });
    }
    return c.json({ config: null });
  });

  // POST /config — save config (admin)
  router.post('/config', zValidator('json', SamlConfigSchema), async (c) => {
    const admin = await requireAdmin(c, auth);
    if (!admin) return c.json({ error: 'Unauthorized' }, 401);

    const data = c.req.valid('json');
    await upsertSamlConfig(db, data);
    return c.json({ success: true });
  });

  return router;
}
