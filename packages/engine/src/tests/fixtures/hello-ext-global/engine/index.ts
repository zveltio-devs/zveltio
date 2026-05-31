/**
 * hello-ext-global — fixture for `mountStrategy: 'global'`.
 *
 * Most first-party extensions use `mountStrategy: 'subapp'` which
 * gives each extension a private `/ext/<name>/*` namespace. Worker
 * isolation (alpha.121) was validated against that strategy. A
 * handful of extensions need a route at the engine root (CDN-style
 * public links, dynamic user-deployed endpoints); those use
 * `'global'`. This fixture exists so the release smoke covers both
 * strategies — if global breaks while subapp keeps working, the
 * regression is in route-mount routing, not in the rest of the
 * pipeline.
 */
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';

const extension: ZveltioExtension = {
  name: 'hello-ext-global',
  category: 'fixture',
  // No mountStrategy → defaults to 'global'. The handler is registered
  // at the engine root so the route lives at /hello-global/health.
  async register(app, _ctx) {
    const routes = new Hono();
    routes.get('/health', (c) => c.json({ ok: true, name: 'hello-ext-global', mount: 'global' }));
    app.route('/hello-global', routes);
  },
};

export default extension;
