/**
 * ExtensionLoader thin delegators — loadExtension, topoSort, marketplace, reload.
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import {
  ExtensionLoader,
  _internalForTests,
  setReloadCallback,
} from '../../lib/extensions/extension-loader.js';
import * as marketplaceRoutes from '../../lib/extensions/extension-marketplace-routes.js';
import * as migrationRunner from '../../lib/extensions/migration-runner.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

const { triggerReload } = _internalForTests;
const noApp = new Hono();

let savedNodeEnv: string | undefined;
let savedInline: string | undefined;

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedInline === undefined) delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
  else process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = savedInline;
  delete process.env.EXTENSIONS_DIR;
  setReloadCallback(async () => {});
});

describe('ExtensionLoader delegators', () => {
  it('topoSortExtensions orders dependencies from manifest files', async () => {
    const base = mkdtempSync(join(tmpdir(), 'zv-topo-'));
    for (const name of ['ext-a', 'ext-b']) {
      mkdirSync(join(base, name), { recursive: true });
      writeFileSync(
        join(base, name, 'manifest.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          dependencies: name === 'ext-b' ? [{ name: 'ext-a' }] : [],
        }),
      );
    }
    const loader = new ExtensionLoader();
    const ordered = await loader.topoSortExtensions(['ext-b', 'ext-a'], base);
    expect(ordered.indexOf('ext-a')).toBeLessThan(ordered.indexOf('ext-b'));
  });

  it('purgeExtensionData delegates to migration-runner', async () => {
    const purgeSpy = spyOn(migrationRunner, 'purgeExtensionData').mockResolvedValue(undefined);
    try {
      const loader = new ExtensionLoader();
      const db = new CannedDb().kysely as unknown as Database;
      await loader.purgeExtensionData('gone', db);
      expect(purgeSpy).toHaveBeenCalledWith('gone', db);
    } finally {
      purgeSpy.mockRestore();
    }
  });

  it('registerMarketplace wires marketplace routes', () => {
    const registerSpy = spyOn(marketplaceRoutes, 'registerMarketplaceRoutes').mockImplementation(
      () => {},
    );
    try {
      const loader = new ExtensionLoader();
      const db = new CannedDb().kysely as unknown as Database;
      loader.registerMarketplace(noApp, db);
      expect(registerSpy).toHaveBeenCalled();
    } finally {
      registerSpy.mockRestore();
    }
  });

  it('setReloadCallback on the instance updates the module callback', async () => {
    _internalForTests.resetReloadState();
    const fn = mock(async () => {});
    const loader = new ExtensionLoader();
    loader.setReloadCallback(fn);
    await triggerReload('delegator-test');
    expect(fn).toHaveBeenCalled();
  });

  it('registerDevEndpoints is a no-op in production', () => {
    savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const app = new Hono();
    const loader = new ExtensionLoader();
    loader.registerDevEndpoints(app);
    expect(app.routes.length).toBe(0);
  });

  it('loadExtension loads a bundled inline extension end-to-end', async () => {
    savedInline = process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const base = mkdtempSync(join(tmpdir(), 'zv-deleg-'));
    process.env.EXTENSIONS_DIR = base;
    const name = 'deleg-inline';
    mkdirSync(join(base, name, 'engine'), { recursive: true });
    writeFileSync(
      join(base, name, 'manifest.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        engine: { bundled: true, entry: 'engine/index.js' },
      }),
    );
    writeFileSync(
      join(base, name, 'engine/index.js'),
      `export default { name: '${name}', mountStrategy: 'subapp', async register(app) { app.get('/ping', (c) => c.text('ok')); } };`,
    );
    const loader = new ExtensionLoader();
    loader.ctx = {
      db: new CannedDb().kysely,
      fieldTypeRegistry: { register: () => {} },
    } as unknown as ExtensionContext;
    await loader.loadExtension(name, noApp, loader.ctx, base);
    expect(loader.isActive(name)).toBe(true);
  });
});
