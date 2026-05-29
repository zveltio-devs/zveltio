/**
 * hello-ext — the smoke-test fixture for the binary install path.
 *
 * Minimal Hono router. The release-smoke job copies this folder into
 * EXTENSIONS_DIR, then exercises marketplace install + enable + a GET
 * against the extension's route. If any part regresses on the compiled
 * binary, the release fails before publishing artifacts.
 */
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';

const extension: ZveltioExtension = {
  name: 'hello-ext',
  category: 'fixture',
  async register(app, _ctx) {
    const routes = new Hono();
    routes.get('/health', (c) => c.json({ ok: true, name: 'hello-ext', version: '1.0.0' }));
    app.route('/', routes);
  },
};

export default extension;
