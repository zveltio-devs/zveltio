/**
 * Fail-closed `/ext/*` auth gate (middleware/extension-auth-gate.ts).
 *
 * Drives the middleware through a real Hono app with a fake session resolver:
 * asserts undeclared routes are 401 for anonymous callers, declared publicRoutes
 * pass through anonymously, an authenticated session always passes, longest-name
 * ownership wins for nested extensions, and the env kill-switch disables it.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  admittedApiKey,
  extensionAuthGate,
  keyAwareCheckPermission,
  registerExtensionPublicRoutes,
  _resetPublicRouteRegistryForTests,
} from '../../middleware/extension-auth-gate.js';

const authWithUser = {
  api: { getSession: async () => ({ user: { id: 'u1', name: 'U', role: 'member' } }) },
};
const authAnon = { api: { getSession: async () => null } };

/** `validateApiKey` stamps `last_used_at` through the pool; any chain resolves. */
const dbStub: unknown = new Proxy(() => {}, {
  get: (_t, prop) => (prop === 'then' ? undefined : () => dbStub),
  apply: () => dbStub,
});
(dbStub as { execute?: unknown }).execute = undefined;

type KeyRow = {
  tenant_id: string | null;
  id?: string;
  name?: string;
  scopes?: unknown;
  created_by?: string | null;
};

/** Stands in for session-prefetch: the key row it would have looked up (or null). */
function appWith(auth: unknown, prefetchedKey?: KeyRow | null) {
  const app = new Hono();
  if (prefetchedKey !== undefined) {
    app.use('*', async (c, next) => {
      c.set('prefetchedApiKey', prefetchedKey as never);
      await next();
    });
  }
  app.use('/ext/*', extensionAuthGate(auth as never, dbStub as never));
  // A representative extension route + a couple of siblings.
  app.get('/ext/sms/config', (c) => c.text('config'));
  app.post('/ext/sms/webhook/twilio', (c) => c.text('hook'));
  app.get('/ext/content/page-builder/cms/:slug', (c) => c.text('page'));
  app.get('/ext/content/page-builder/blocks', (c) => c.text('blocks'));
  // What an extension handler sees: the caller, and its own `ctx.checkPermission`.
  const casbin: string[] = [];
  const check = keyAwareCheckPermission('finance/invoicing', async (u, r, a) => {
    casbin.push(`${u}:${r}:${a}`);
    return u === 'u1';
  });
  const seen = async (c: { get: (k: 'user') => { id: string }; json: (b: unknown) => Response }) =>
    c.json({
      user: c.get('user').id,
      admitted: admittedApiKey()?.id ?? null,
      create: await check(c.get('user').id, 'invoices', 'create'),
      settle: await check(c.get('user').id, 'invoices', 'settle'),
      casbin,
    });
  app.get('/ext/finance/invoicing/invoices', seen as never);
  app.post('/ext/finance/invoicing/invoices', seen as never);
  app.delete('/ext/finance/invoicing/invoices/:id', seen as never);
  app.get('/ext/finance/invoicing/company', seen as never);
  return app;
}

afterEach(() => {
  _resetPublicRouteRegistryForTests();
  process.env.ZVELTIO_EXT_AUTH_GATE = undefined as unknown as string;
});

describe('extensionAuthGate', () => {
  it('401s an anonymous call to an undeclared route', async () => {
    registerExtensionPublicRoutes('sms', []); // nothing public
    const res = await appWith(authAnon).request('/ext/sms/config');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('EXT_AUTH_REQUIRED');
  });

  it('lets an anonymous call through to a declared public route', async () => {
    registerExtensionPublicRoutes('sms', ['/webhook/twilio']);
    const res = await appWith(authAnon).request('/ext/sms/webhook/twilio', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hook');
  });

  it('still gates a sibling of a public route', async () => {
    registerExtensionPublicRoutes('sms', ['/webhook/twilio']);
    const res = await appWith(authAnon).request('/ext/sms/config');
    expect(res.status).toBe(401);
  });

  it('lets an authenticated session reach any route', async () => {
    registerExtensionPublicRoutes('sms', []);
    const res = await appWith(authWithUser).request('/ext/sms/config');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('config');
  });

  // The SDK signs its client out on any 401, so a valid key is refused with 403.
  it('403s a valid API key of this tenant — and never lets it through', async () => {
    registerExtensionPublicRoutes('sms', []);
    const key = 'zvk_0123456789abcdef';
    const sends: Record<string, string>[] = [
      { 'X-API-Key': key },
      { Authorization: `Bearer ${key}` },
    ];
    for (const headers of sends) {
      const res = await appWith(authAnon, { tenant_id: null }).request('/ext/sms/config', {
        headers,
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('EXT_SESSION_REQUIRED');
    }
  });

  it('401s an unknown key and a key of another tenant', async () => {
    registerExtensionPublicRoutes('sms', []);
    const headers = { 'X-API-Key': 'zvk_0123456789abcdef' };
    const unknown = await appWith(authAnon, null).request('/ext/sms/config', { headers });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { code: string }).code).toBe('EXT_AUTH_REQUIRED');
    const foreign = await appWith(authAnon, {
      tenant_id: '00000000-0000-0000-0000-0000000000fd',
    }).request('/ext/sms/config', { headers });
    expect(foreign.status).toBe(401);
  });

  it('supports wildcard patterns', async () => {
    registerExtensionPublicRoutes('content/page-builder', ['/cms/*']);
    const app = appWith(authAnon);
    expect((await app.request('/ext/content/page-builder/cms/home')).status).toBe(200);
    // A non-cms route on the same extension stays gated.
    expect((await app.request('/ext/content/page-builder/blocks')).status).toBe(401);
  });

  it('resolves the LONGEST owning extension name (nested)', async () => {
    // Both a parent and a nested extension exist; the nested one owns the path.
    registerExtensionPublicRoutes('content', ['/cms/*']); // would falsely match
    registerExtensionPublicRoutes('content/page-builder', []); // real owner, nothing public
    const res = await appWith(authAnon).request('/ext/content/page-builder/cms/home');
    // Owner is content/page-builder (longer), which declares nothing public → 401.
    expect(res.status).toBe(401);
  });

  it('is disabled by ZVELTIO_EXT_AUTH_GATE=0', async () => {
    process.env.ZVELTIO_EXT_AUTH_GATE = '0';
    registerExtensionPublicRoutes('sms', []);
    const res = await appWith(authAnon).request('/ext/sms/config');
    expect(res.status).toBe(200);
  });

  it('never gates a CORS preflight', async () => {
    registerExtensionPublicRoutes('sms', []);
    const res = await appWith(authAnon).request('/ext/sms/config', { method: 'OPTIONS' });
    expect(res.status).not.toBe(401);
  });

  describe('apiKeyRoutes', () => {
    const KEY_ID = '11111111-1111-4111-8111-111111111111';
    const headers = { 'X-API-Key': 'zvk_0123456789abcdef' };
    const key = (scopes: unknown, tenant_id: string | null = null): KeyRow => ({
      tenant_id,
      id: KEY_ID,
      name: 'k',
      scopes,
      created_by: 'issuer',
    });
    const INV = [{ collection: '$ext:finance/invoicing', actions: ['read', 'create'] }];
    const declareRoutes = () =>
      registerExtensionPublicRoutes('finance/invoicing', [], ['GET /invoices', 'POST /invoices']);
    const body = async (res: Response) =>
      (await res.json()) as {
        user: string;
        admitted: string | null;
        create: boolean;
        settle: boolean;
        casbin: string[];
        code?: string;
      };

    it('admits a key holding $ext:<name> on a declared route, as the key principal', async () => {
      declareRoutes();
      const app = appWith(authAnon, key(INV));
      for (const method of ['GET', 'POST']) {
        const res = await app.request('/ext/finance/invoicing/invoices', { method, headers });
        expect(res.status).toBe(200);
        const b = await body(res);
        expect(b.user).toBe(`apikey:${KEY_ID}`);
        expect(b.admitted).toBe(`apikey:${KEY_ID}`);
        // The extension's own checks read the scope — Casbin is never asked for a key.
        expect(b.create).toBe(true);
        expect(b.settle).toBe(false);
        expect(b.casbin).toEqual([]);
      }
    });

    it('403s a key without the action, with another extension scope, or with a `*` data grant', async () => {
      declareRoutes();
      for (const scopes of [
        [{ collection: '$ext:finance/invoicing', actions: ['read'] }],
        [{ collection: '$ext:crm', actions: ['*'] }],
        [{ collection: '*', actions: ['*'] }],
      ]) {
        const res = await appWith(authAnon, key(scopes)).request(
          '/ext/finance/invoicing/invoices',
          { method: 'POST', headers },
        );
        expect(res.status).toBe(403);
      }
    });

    it('keeps an undeclared route or method session-only for the same key', async () => {
      declareRoutes();
      const app = appWith(
        authAnon,
        key([{ collection: '$ext:finance/invoicing', actions: ['*'] }]),
      );
      for (const [path, method] of [
        ['/ext/finance/invoicing/company', 'GET'],
        ['/ext/finance/invoicing/invoices/x', 'DELETE'],
      ] as const) {
        const res = await app.request(path, { method, headers });
        expect(res.status).toBe(403);
        expect((await body(res)).code).toBe('EXT_SESSION_REQUIRED');
      }
    });

    it('401s an unknown key and another tenant key on a declared route', async () => {
      declareRoutes();
      const unknown = await appWith(authAnon, null).request('/ext/finance/invoicing/invoices', {
        headers,
      });
      expect(unknown.status).toBe(401);
      const foreign = await appWith(
        authAnon,
        key(INV, '00000000-0000-0000-0000-0000000000fd'),
      ).request('/ext/finance/invoicing/invoices', { headers });
      expect(foreign.status).toBe(401);
    });

    it('leaves a session unchanged, and a key id outside the admitted request refused', async () => {
      declareRoutes();
      const res = await appWith(authWithUser).request('/ext/finance/invoicing/invoices');
      const b = await body(res);
      expect(b.user).toBe('u1');
      expect(b.admitted).toBeNull();
      expect(b.casbin).toEqual(['u1:invoices:create', 'u1:invoices:settle']);
      const check = keyAwareCheckPermission('finance/invoicing', async () => true);
      expect(await check(`apikey:${KEY_ID}`, 'invoices', 'read')).toBe(false);
    });
  });
});
