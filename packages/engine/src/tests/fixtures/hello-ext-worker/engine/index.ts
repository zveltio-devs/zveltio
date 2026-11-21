/**
 * hello-ext-worker — proves the worker isolation path
 * (manifest.engine.isolation === 'worker') works on the compiled binary.
 *
 * A signed worker extension is declared model only (ADR 0056), so the
 * health route is a declared route: the manifest names it, the engine
 * serves it, and the handler runs in the worker. If anything in the IPC
 * chain regresses, the release smoke fails before publishing artifacts.
 * `engine/index.js` is this file by hand (no imports, nothing to bundle).
 */
import type { ZveltioExtension } from '@zveltio/sdk/extension';

const extension: ZveltioExtension = {
  name: 'hello-ext-worker',
  category: 'fixture',
  routes: {
    health: () =>
      Response.json({
        ok: true,
        name: 'hello-ext-worker',
        isolation: 'worker',
        runtime: 'bun-worker',
      }),
  },
  async register() {},
};

export default extension;
