/**
 * hello-ext-worker — proves the C-minimal worker isolation path
 * (manifest.engine.isolation === 'worker') works on the compiled binary.
 *
 * Same minimal API surface as hello-ext but the engine spawns it in a
 * Bun.Worker. Route handler runs in the worker; the host postMessage-
 * forwards the request and writes the worker's reply back to the
 * client. If anything in the IPC chain regresses, the release smoke
 * fails before publishing artifacts.
 */
import { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';

const extension: ZveltioExtension = {
  name: 'hello-ext-worker',
  category: 'fixture',
  mountStrategy: 'subapp',
  async register(app, _ctx) {
    const routes = new Hono();
    routes.get('/health', (c) =>
      c.json({
        ok: true,
        name: 'hello-ext-worker',
        isolation: 'worker',
        runtime: 'bun-worker',
      }),
    );
    app.route('/', routes);
  },
};

export default extension;
