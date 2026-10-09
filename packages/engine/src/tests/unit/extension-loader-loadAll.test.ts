/**
 * ExtensionLoader.loadAll — env-driven boot load without touching disk/npm.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import type { Database } from '../../db/index.js';
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

describe('ExtensionLoader boot order — ZVELTIO_EXTENSIONS and the registry together', () => {
  it('loads a registry-enabled dependency before the env-listed extension that needs it', async () => {
    // `env-ext` (in ZVELTIO_EXTENSIONS) depends on `db-ext` (enabled only in the
    // registry). Env and registry were sorted as two batches and the env batch
    // went first, so `env-ext` registered while `db-ext` was not loaded yet.
    const base = mkdtempSync(join(tmpdir(), 'zv-boot-order-'));
    for (const [name, deps] of Object.entries({ 'env-ext': ['db-ext'], 'db-ext': [] })) {
      mkdirSync(join(base, name));
      writeFileSync(
        join(base, name, 'manifest.json'),
        JSON.stringify({ name, dependencies: deps.map((d) => ({ name: d })) }),
      );
    }
    savedExtensions = process.env.ZVELTIO_EXTENSIONS;
    savedExternalPath = process.env.ZVELTIO_EXTENSIONS_PATH;
    const savedDir = process.env.EXTENSIONS_DIR;
    process.env.ZVELTIO_EXTENSIONS = 'env-ext';
    process.env.EXTENSIONS_DIR = base;
    delete process.env.ZVELTIO_EXTENSIONS_PATH;
    const deps = await import('../../lib/extensions/extension-deps.js');
    const depsSpy = spyOn(deps, 'ensureExtensionCoreDeps').mockResolvedValue(undefined as never);
    try {
      const db = new CannedDb();
      db.when(/from "zv_extension_registry"/i, [{ name: 'db-ext' }, { name: 'env-ext' }]);
      const loader = new ExtensionLoader();
      const order: string[] = [];
      loader.loadExtension = async (name) => {
        order.push(name);
        loader.loaded.set(name, { registeredRoutes: false } as never);
      };

      // The boot sequence index.ts runs.
      await loader.loadAll(noApp, { db: db.kysely } as ExtensionContext);
      await loader.loadFromDB(db.kysely as unknown as Database, noApp);

      // Once each, dependency first.
      expect(order).toEqual(['db-ext', 'env-ext']);
    } finally {
      depsSpy.mockRestore();
      if (savedDir === undefined) delete process.env.EXTENSIONS_DIR;
      else process.env.EXTENSIONS_DIR = savedDir;
      rmSync(base, { recursive: true, force: true });
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
