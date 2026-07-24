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
  extensionAuthGate,
  registerExtensionPublicRoutes,
  _resetPublicRouteRegistryForTests,
} from '../../middleware/extension-auth-gate.js';

const authWithUser = {
  api: { getSession: async () => ({ user: { id: 'u1', name: 'U', role: 'member' } }) },
};
const authAnon = { api: { getSession: async () => null } };

function appWith(auth: unknown) {
  const app = new Hono();
  app.use('/ext/*', extensionAuthGate(auth as never));
  // A representative extension route + a couple of siblings.
  app.get('/ext/sms/config', (c) => c.text('config'));
  app.post('/ext/sms/webhook/twilio', (c) => c.text('hook'));
  app.get('/ext/content/page-builder/cms/:slug', (c) => c.text('page'));
  app.get('/ext/content/page-builder/blocks', (c) => c.text('blocks'));
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
});
