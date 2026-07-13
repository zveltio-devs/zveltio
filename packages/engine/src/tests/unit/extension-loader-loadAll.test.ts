/**
 * ExtensionLoader.loadAll — env-driven boot load without touching disk/npm.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

const noApp = {} as unknown as Hono;
let savedExtensions: string | undefined;
let savedExternalPath: string | undefined;

afterEach(() => {
  if (savedExtensions === undefined) delete process.env.ZVELTIO_EXTENSIONS;
  else process.env.ZVELTIO_EXTENSIONS = savedExtensions;
  if (savedExternalPath === undefined) delete process.env.ZVELTIO_EXTENSIONS_PATH;
  else process.env.ZVELTIO_EXTENSIONS_PATH = savedExternalPath;
});

describe('ExtensionLoader.loadAll', () => {
  it('loads every name from ZVELTIO_EXTENSIONS via loadExtension', async () => {
    savedExtensions = process.env.ZVELTIO_EXTENSIONS;
    process.env.ZVELTIO_EXTENSIONS = 'ext-a,ext-b';

    const loader = new ExtensionLoader();
    const order: string[] = [];
    loader.loadExtension = async (name) => {
      order.push(name);
      loader.loaded.set(name, { registeredRoutes: false } as never);
    };

    const ctx = { db: new CannedDb().kysely } as ExtensionContext;
    await loader.loadAll(noApp, ctx);

    expect(loader.ctx).toBe(ctx);
    expect(order.sort()).toEqual(['ext-a', 'ext-b']);
  });

  it('skips external discovery when ZVELTIO_EXTENSIONS_PATH is unset', async () => {
    savedExtensions = process.env.ZVELTIO_EXTENSIONS;
    savedExternalPath = process.env.ZVELTIO_EXTENSIONS_PATH;
    delete process.env.ZVELTIO_EXTENSIONS_PATH;
    process.env.ZVELTIO_EXTENSIONS = 'only-one';

    const loader = new ExtensionLoader();
    const calls: string[] = [];
    loader.loadExtension = async (name) => {
      calls.push(name);
      loader.loaded.set(name, { registeredRoutes: false } as never);
    };
    loader.topoSortExtensions = async (names) => names;

    await loader.loadAll(noApp, { db: new CannedDb().kysely } as ExtensionContext);
    expect(calls).toEqual(['only-one']);
  });

  it('continues boot when ensureExtensionCoreDeps rejects (non-fatal warn)', async () => {
    savedExtensions = process.env.ZVELTIO_EXTENSIONS;
    process.env.ZVELTIO_EXTENSIONS = 'deps-ok';

    const deps = await import('../../lib/extensions/extension-deps.js');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const depsSpy = spyOn(deps, 'ensureExtensionCoreDeps').mockRejectedValue(
      new Error('npm registry down'),
    );

    const loader = new ExtensionLoader();
    loader.loadExtension = async (name) => {
      loader.loaded.set(name, { registeredRoutes: false } as never);
    };

    try {
      await loader.loadAll(noApp, { db: new CannedDb().kysely } as ExtensionContext);
      expect(loader.isActive('deps-ok')).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Core dep install failed'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
      depsSpy.mockRestore();
    }
  });
});

describe('ExtensionLoader.unload', () => {
  it('unloads a loaded extension via lifecycle', async () => {
    const loader = new ExtensionLoader();
    loader.loaded.set('gone', { name: 'gone', registeredRoutes: false } as never);
    loader.ctx = { db: new CannedDb().kysely } as ExtensionContext;

    const result = await loader.unload('gone');
    expect(result.unloaded).toBe(true);
    expect(loader.loaded.has('gone')).toBe(false);
  });
});
