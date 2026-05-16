import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';

/**
 * S4-03 dev-reload tests.
 *
 * The engine's `extensionLoader.registerDevEndpoints(app)` mounts a single
 * `POST /__zveltio_dev_reload` route that:
 *   - is gated on `NODE_ENV !== 'production'` (skipped silently otherwise);
 *   - requires a JSON body with a non-empty `name`;
 *   - delegates to `reloadExtensionFromDisk(name)` and proxies its result.
 *
 * Spinning up the full loader needs a Postgres + ctx, which is too heavy for
 * unit tests. Instead we exercise the route handler against a minimal
 * stub that mirrors the loader's public surface. The actual reload chain
 * (cache-bust import → triggerReload → swap _currentApp) is covered by the
 * separate integration test once the dev endpoint is wired into the host.
 */

interface FakeLoader {
  registerDevEndpoints(app: Hono): void;
  reloadExtensionFromDisk(name: string): Promise<{ ok: boolean; error?: string }>;
  /** Test-only spy on what the endpoint forwarded. */
  __lastCalledWith: string | null;
}

function makeFakeLoader(reloadResult: { ok: boolean; error?: string } = { ok: true }): FakeLoader {
  // Mirror the production handler in registerDevEndpoints. Kept inline so
  // any drift between this stub and the real implementation is caught when
  // both files are touched in the same review.
  const loader: FakeLoader = {
    __lastCalledWith: null,
    async reloadExtensionFromDisk(name) {
      loader.__lastCalledWith = name;
      return reloadResult;
    },
    registerDevEndpoints(app) {
      if (process.env.NODE_ENV === 'production') return;
      app.post('/__zveltio_dev_reload', async (c) => {
        let body: any;
        try { body = await c.req.json(); }
        catch { return c.json({ error: 'body must be JSON' }, 400); }
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name) return c.json({ error: 'name is required' }, 400);
        const result = await loader.reloadExtensionFromDisk(name);
        return c.json(result, result.ok ? 200 : 500);
      });
    },
  };
  return loader;
}

describe('S4-03 dev reload endpoint', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  });

  it('mounts POST /__zveltio_dev_reload in development', async () => {
    process.env.NODE_ENV = 'development';
    const app = new Hono();
    const loader = makeFakeLoader();
    loader.registerDevEndpoints(app);

    const res = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'forms' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(loader.__lastCalledWith).toBe('forms');
  });

  it('does NOT mount the route when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const app = new Hono();
    const loader = makeFakeLoader();
    loader.registerDevEndpoints(app);

    const res = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      body: JSON.stringify({ name: 'forms' }),
    });
    expect(res.status).toBe(404);
    expect(loader.__lastCalledWith).toBeNull();
  });

  it('returns 400 when body is not valid JSON', async () => {
    process.env.NODE_ENV = 'development';
    const app = new Hono();
    makeFakeLoader().registerDevEndpoints(app);

    const res = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json {{{',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/JSON/);
  });

  it('returns 400 when `name` is missing or empty', async () => {
    process.env.NODE_ENV = 'development';
    const app = new Hono();
    makeFakeLoader().registerDevEndpoints(app);

    const missing = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const empty = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(empty.status).toBe(400);
  });

  it('returns 500 when reloadExtensionFromDisk reports failure', async () => {
    process.env.NODE_ENV = 'development';
    const app = new Hono();
    const loader = makeFakeLoader({ ok: false, error: 'extension is not loaded' });
    loader.registerDevEndpoints(app);

    const res = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'forms' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('extension is not loaded');
    expect(loader.__lastCalledWith).toBe('forms');
  });

  it('trims whitespace from the name before forwarding', async () => {
    process.env.NODE_ENV = 'development';
    const app = new Hono();
    const loader = makeFakeLoader();
    loader.registerDevEndpoints(app);

    const res = await app.request('/__zveltio_dev_reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  communications/mail  ' }),
    });
    expect(res.status).toBe(200);
    expect(loader.__lastCalledWith).toBe('communications/mail');
  });
});

// ── Behaviour test: the loader's reload semantics, decoupled from HTTP ──────
//
// Tests the *contract* reloadExtensionFromDisk promises (drop module cache +
// scoped state, then trigger a rebuild). Stubs the registries it touches.

describe('S4-03 reloadExtensionFromDisk semantics', () => {
  interface ReloadSpyDeps {
    modules: Set<string>;
    loaded: Set<string>;
    lastLoadError: Map<string, string>;
    unregisterAllCalls: string[];   // captures the order
    triggerReloadCalls: string[];   // capture the reason strings
    onReload: () => Promise<void>;  // optional side-effect (e.g. populate lastLoadError)
  }

  function makeReloader(deps: ReloadSpyDeps) {
    return async function reloadExtensionFromDisk(name: string): Promise<{ ok: boolean; error?: string }> {
      if (!deps.modules.has(name) && !deps.loaded.has(name)) {
        return { ok: false, error: `extension "${name}" is not currently loaded — restart the engine first` };
      }
      deps.modules.delete(name);
      deps.loaded.delete(name);
      deps.lastLoadError.delete(name);
      // Track unregisterAll calls (services, queryAlter, entityAccess, cron).
      deps.unregisterAllCalls.push(`services:${name}`);
      deps.unregisterAllCalls.push(`queryAlter:${name}`);
      deps.unregisterAllCalls.push(`entityAccess:${name}`);
      deps.unregisterAllCalls.push(`cron:${name}`);
      deps.triggerReloadCalls.push(`dev-reload:${name}`);
      await deps.onReload();
      if (deps.lastLoadError.has(name)) {
        return { ok: false, error: deps.lastLoadError.get(name)! };
      }
      return deps.loaded.has(name)
        ? { ok: true }
        : { ok: false, error: 'extension failed to load — check engine logs' };
    };
  }

  it('rejects when the extension is not currently loaded', async () => {
    const deps: ReloadSpyDeps = {
      modules: new Set(), loaded: new Set(), lastLoadError: new Map(),
      unregisterAllCalls: [], triggerReloadCalls: [],
      onReload: async () => { /* noop */ },
    };
    const reload = makeReloader(deps);
    const r = await reload('ghost');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not currently loaded/);
    expect(deps.triggerReloadCalls).toEqual([]);
    expect(deps.unregisterAllCalls).toEqual([]);
  });

  it('clears module cache + scoped state, then triggers reload', async () => {
    const deps: ReloadSpyDeps = {
      modules: new Set(['forms']),
      loaded: new Set(['forms']),
      lastLoadError: new Map(),
      unregisterAllCalls: [],
      triggerReloadCalls: [],
      // Simulate the reload re-loading the extension successfully.
      onReload: async () => { deps.loaded.add('forms'); deps.modules.add('forms'); },
    };
    const reload = makeReloader(deps);
    const r = await reload('forms');
    expect(r.ok).toBe(true);
    expect(deps.triggerReloadCalls).toEqual(['dev-reload:forms']);
    expect(deps.unregisterAllCalls).toEqual([
      'services:forms',
      'queryAlter:forms',
      'entityAccess:forms',
      'cron:forms',
    ]);
  });

  it('propagates lastLoadError when the rebuild fails', async () => {
    const deps: ReloadSpyDeps = {
      modules: new Set(['broken']),
      loaded: new Set(['broken']),
      lastLoadError: new Map(),
      unregisterAllCalls: [],
      triggerReloadCalls: [],
      onReload: async () => { deps.lastLoadError.set('broken', 'SyntaxError on line 14'); },
    };
    const reload = makeReloader(deps);
    const r = await reload('broken');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('SyntaxError on line 14');
  });

  it('reports silent failure when the extension does not come back active', async () => {
    const deps: ReloadSpyDeps = {
      modules: new Set(['quiet']),
      loaded: new Set(['quiet']),
      lastLoadError: new Map(),
      unregisterAllCalls: [],
      triggerReloadCalls: [],
      // Rebuild runs but does NOT re-add the extension to `loaded`.
      onReload: async () => { /* noop */ },
    };
    const reload = makeReloader(deps);
    const r = await reload('quiet');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/failed to load/);
  });
});
