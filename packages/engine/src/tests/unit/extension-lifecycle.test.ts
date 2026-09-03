/**
 * Unit coverage for extensions/lifecycle.ts — unloadExtension + loadDynamic.
 *
 * unloadExtension is driven against a minimal fake ExtensionLoader (a `loaded`
 * Map + a ctx.db CannedDb for the audit write) and the REAL registries, so we
 * can assert it actually unregisters the extension's services. loadDynamic is
 * driven against a fake loader whose loadExtension/isActive are spies.
 *
 * No disk, no Postgres.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  loadDynamic,
  reloadExtensionFromDisk,
  unloadExtension,
} from '../../lib/extensions/lifecycle.js';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { getWorkerHost, type WorkerExtensionHost } from '../../lib/worker-extension-host.js';

/**
 * The host's worker map, which is private. Reached through `unknown` rather
 * than `any` so nothing else about the host silently loses its types.
 */
function hostWorkers(h: WorkerExtensionHost): Map<string, unknown> {
  return (h as unknown as { workers: Map<string, unknown> }).workers;
}
import { CannedDb } from './fixtures/canned-db.js';

function fakeLoader(over: Record<string, unknown> = {}): any {
  const db = new CannedDb();
  return {
    loaded: new Map(),
    modules: new Map(),
    ctx: { db: db.kysely },
    lastLoadError: new Map(),
    extDirs: new Map(),
    forgetExtensionMessages: () => {},
    isActive: () => false,
    ...over,
  };
}

const noApp = {} as unknown as Hono;

afterEach(() => {
  for (const owner of ['e-svc', 'e-reload']) serviceRegistry.unregisterAll(owner);
});

describe('unloadExtension', () => {
  it('reports not-loaded for an unknown extension', async () => {
    const r = await unloadExtension(fakeLoader(), 'nope');
    expect(r).toEqual({
      unloaded: false,
      needs_restart: false,
      message: 'Extension "nope" is not loaded.',
    });
  });

  it('runs cleanup, drops the extension, and needs no restart without routes', async () => {
    const loader = fakeLoader();
    let cleaned = false;
    loader.loaded.set('e1', {
      cleanup: async () => {
        cleaned = true;
      },
      registeredRoutes: false,
    });

    const r = await unloadExtension(loader, 'e1');
    expect(cleaned).toBe(true);
    expect(r.unloaded).toBe(true);
    expect(r.needs_restart).toBe(false);
    expect(loader.loaded.has('e1')).toBe(false);
  });

  it('flags needs_restart when the extension had registered routes', async () => {
    const loader = fakeLoader();
    loader.loaded.set('e1', { registeredRoutes: true });
    const r = await unloadExtension(loader, 'e1');
    expect(r.needs_restart).toBe(true);
    expect(r.message).toMatch(/restart/i);
  });

  it('takes the extension event listeners away with it', async () => {
    // Without this, a reload leaves the previous load's handlers alive and one
    // event runs them all — a single invoice fired the same handler three times
    // after two reloads, and the extension looked like it had a duplication bug.
    const handlers = new Set<() => void>();
    class Bus {
      on(_event: string, h: () => void) {
        handlers.add(h);
        return () => handlers.delete(h);
      }
    }
    const bus = new Bus();
    const ctx = buildRestrictedContext(
      { events: bus } as unknown as Parameters<typeof buildRestrictedContext>[0],
      'e-listeners',
      new Hono(),
      undefined,
      false,
    );
    (ctx.events as unknown as Bus).on('record.created', () => {});
    expect(handlers.size).toBe(1);

    const loader = fakeLoader();
    loader.loaded.set('e-listeners', { registeredRoutes: false });
    await unloadExtension(loader, 'e-listeners');
    expect(handlers.size).toBe(0);
  });

  it('still unloads when the extension cleanup() throws', async () => {
    const loader = fakeLoader();
    loader.loaded.set('e1', {
      cleanup: async () => {
        throw new Error('cleanup boom');
      },
      registeredRoutes: false,
    });
    const r = await unloadExtension(loader, 'e1');
    expect(r.unloaded).toBe(true);
    expect(loader.loaded.has('e1')).toBe(false);
  });

  it('unregisters the extension services from the registry', async () => {
    serviceRegistry.registerAs('e-svc', 'someService', { hello: 1 });
    expect(serviceRegistry.has('someService')).toBe(true);

    const loader = fakeLoader();
    loader.loaded.set('e-svc', { registeredRoutes: false });
    await unloadExtension(loader, 'e-svc');

    expect(serviceRegistry.has('someService')).toBe(false);
  });

  it('terminates the extension worker', async () => {
    // Unload dropped every main-thread trace of the extension and left the
    // worker running — and the worker is the isolation boundary for
    // community-tier extensions, holding the SQL bridge and its own timers. A
    // "disabled" third-party extension went on querying the database.
    const host = getWorkerHost(noApp);
    let terminated = false;
    let unmounted = false;
    // Drive the real stop() path by planting a worker in the host's map; a
    // spy on stop() would pass even if stop() itself stopped working.
    hostWorkers(host).set('e-worker', {
      name: 'e-worker',
      stopped: false,
      heartbeatTimer: undefined,
      registeredServices: new Set<string>(),
      proxyUnmount: () => {
        unmounted = true;
      },
      worker: {
        terminate: () => {
          terminated = true;
        },
      },
    });
    expect(host.isRunning('e-worker')).toBe(true);

    const loader = fakeLoader();
    loader.loaded.set('e-worker', { registeredRoutes: false });
    const r = await unloadExtension(loader, 'e-worker');

    expect(r.unloaded).toBe(true);
    expect(terminated).toBe(true);
    expect(unmounted).toBe(true);
    expect(host.isRunning('e-worker')).toBe(false);
  });

  it('still unloads when the worker refuses to stop', async () => {
    // A wedged worker must not make it impossible to disable an extension.
    const host = getWorkerHost(noApp);
    hostWorkers(host).set('e-stuck', {
      name: 'e-stuck',
      stopped: false,
      registeredServices: new Set<string>(),
      proxyUnmount: () => {
        throw new Error('unmount boom');
      },
      worker: { terminate: () => {} },
    });

    const loader = fakeLoader();
    loader.loaded.set('e-stuck', { registeredRoutes: false });
    const r = await unloadExtension(loader, 'e-stuck');

    expect(r.unloaded).toBe(true);
    expect(loader.loaded.has('e-stuck')).toBe(false);
    hostWorkers(host).delete('e-stuck');
  });
});

describe('loadDynamic', () => {
  it('throws when the loader has no ctx (not initialized)', async () => {
    await expect(loadDynamic(fakeLoader({ ctx: undefined }), 'x', noApp)).rejects.toThrow(
      /not initialized/i,
    );
  });

  it('delegates to loader.loadExtension and resolves when the extension becomes active', async () => {
    let loadedName = '';
    const loader = fakeLoader({
      loadExtension: async (n: string) => {
        loadedName = n;
      },
      isActive: () => true,
    });
    await loadDynamic(loader, 'e3', noApp);
    expect(loadedName).toBe('e3');
  });

  it('throws the recorded load error when the extension fails to activate', async () => {
    // loadDynamic clears lastLoadError before calling loadExtension, so a real
    // failure records the error DURING loadExtension — mirror that here.
    const loader = fakeLoader({ isActive: () => false });
    loader.loadExtension = async (n: string) => {
      loader.lastLoadError.set(n, 'manifest invalid');
    };
    await expect(loadDynamic(loader, 'e4', noApp)).rejects.toThrow(/manifest invalid/);
  });

  it('throws a helpful fallback error when no specific error was recorded', async () => {
    const loader = fakeLoader({ loadExtension: async () => {}, isActive: () => false });
    await expect(loadDynamic(loader, 'e5', noApp)).rejects.toThrow(/engine\/index\.ts not found/);
  });
});

describe('reloadExtensionFromDisk', () => {
  it('returns an error when the extension is not loaded', async () => {
    const r = await reloadExtensionFromDisk(fakeLoader(), 'missing', async () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not currently loaded/i);
  });

  it('clears module state, unregisters services, and invokes triggerReload', async () => {
    serviceRegistry.registerAs('e-reload', 'reloadSvc', { x: 1 });
    const loader = fakeLoader({ isActive: () => true });
    loader.modules.set('e-reload', {});
    loader.loaded.set('e-reload', {});
    let reason = '';
    const r = await reloadExtensionFromDisk(loader, 'e-reload', async (why) => {
      reason = why;
    });
    expect(reason).toBe('dev-reload:e-reload');
    expect(loader.modules.has('e-reload')).toBe(false);
    expect(loader.loaded.has('e-reload')).toBe(false);
    expect(serviceRegistry.has('reloadSvc')).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('surfaces lastLoadError from the reload attempt', async () => {
    const loader = fakeLoader({ isActive: () => false });
    loader.loaded.set('e-bad', {});
    const r = await reloadExtensionFromDisk(loader, 'e-bad', async () => {
      loader.lastLoadError.set('e-bad', 'syntax error in engine/index.ts');
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('syntax error in engine/index.ts');
  });

  it('reports a generic failure when reload leaves the extension inactive', async () => {
    const loader = fakeLoader({ isActive: () => false });
    loader.modules.set('e-inert', {});
    const r = await reloadExtensionFromDisk(loader, 'e-inert', async () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/failed to load/i);
  });
});
