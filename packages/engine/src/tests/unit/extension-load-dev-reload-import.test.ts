/**
 * load.ts — unbundled extension import with ZVELTIO_EXTENSION_DEV_RELOAD cache buster.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CORE_NPM_PACKAGES } from '../../lib/extensions/extension-deps.js';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function seedCoreDeps(extBase: string): void {
  for (const pkg of CORE_NPM_PACKAGES) {
    const pkgFolder = pkg.startsWith('@') ? pkg : pkg.split('/')[0];
    const dir = join(extBase, 'node_modules', pkgFolder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
  }
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    EXTENSIONS_DIR: process.env.EXTENSIONS_DIR,
    ZVELTIO_EXTENSION_DEV_RELOAD: process.env.ZVELTIO_EXTENSION_DEV_RELOAD,
    NODE_ENV: process.env.NODE_ENV,
    ZVELTIO_ALLOW_INLINE_THIRD_PARTY: process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY,
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('loadExtensionFromDir — dev reload import path', () => {
  it('loads an unbundled extension when dev reload is enabled and core deps exist', async () => {
    const extBase = mkdtempSync(join(tmpdir(), 'zv-extbase-reload-'));
    seedCoreDeps(extBase);
    process.env.EXTENSIONS_DIR = extBase;
    process.env.ZVELTIO_EXTENSION_DEV_RELOAD = '1';
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    process.env.NODE_ENV = 'development';

    const extDir = join(extBase, 'dev-reload');
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({ name: 'dev-reload', version: '1.0.0' }),
    );
    writeFileSync(
      join(extDir, 'engine/index.js'),
      `export default {
        name: 'dev-reload',
        mountStrategy: 'subapp',
        async register(app) { app.get('/dev-reload-ping', (c) => c.text('ok')); },
      };`,
    );

    const db = new CannedDb();
    const loader = {
      loaded: new Map(),
      manifestMeta: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx: {
        db: db.kysely,
        fieldTypeRegistry: { register: () => {} },
      } as unknown as ExtensionContext,
    };

    await loadExtensionFromDir(loader as never, 'dev-reload', new Hono(), loader.ctx, extBase);
    expect(loader.loaded.has('dev-reload')).toBe(true);
    expect(loader.lastLoadError.get('dev-reload')).toBeUndefined();
  });

  // Regression: the cache-buster appended `?v=<timestamp>` to the import URL
  // to force a fresh read of edited source. Bun's dynamic import() caches by
  // resolved PATHNAME and ignores query strings — verified live on Bun
  // 1.3.14, a second import() of the same path with a different `?v=` still
  // returned the first call's module. So a second load after editing the
  // extension's source silently kept registering the OLD code: this is the
  // entire feature ZVELTIO_EXTENSION_DEV_RELOAD exists to provide, and it did
  // nothing. The fix copies the entry to a distinct sibling path per load
  // (same directory, so relative imports + the node_modules walk-up still
  // resolve) instead of relying on the query string.
  it('picks up an edit to engine/index.js on a second load (not the query string)', async () => {
    const extBase = mkdtempSync(join(tmpdir(), 'zv-extbase-reload2-'));
    seedCoreDeps(extBase);
    process.env.EXTENSIONS_DIR = extBase;
    process.env.ZVELTIO_EXTENSION_DEV_RELOAD = '1';
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    process.env.NODE_ENV = 'development';

    const extDir = join(extBase, 'dev-reload-2');
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({ name: 'dev-reload-2', version: '1.0.0' }),
    );
    const entryPath = join(extDir, 'engine/index.js');
    writeFileSync(
      entryPath,
      `export default { name: 'dev-reload-2', version: 1, async register() {} };`,
    );

    const db = new CannedDb();
    const loader = {
      loaded: new Map(),
      manifestMeta: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx: {
        db: db.kysely,
        fieldTypeRegistry: { register: () => {} },
      } as unknown as ExtensionContext,
    };

    await loadExtensionFromDir(loader as never, 'dev-reload-2', new Hono(), loader.ctx, extBase);
    expect((loader.modules.get('dev-reload-2') as { version: number }).version).toBe(1);

    writeFileSync(
      entryPath,
      `export default { name: 'dev-reload-2', version: 2, async register() {} };`,
    );
    // Mirror what reloadExtensionFromDisk does before re-loading.
    loader.loaded.delete('dev-reload-2');
    loader.modules.delete('dev-reload-2');

    await loadExtensionFromDir(loader as never, 'dev-reload-2', new Hono(), loader.ctx, extBase);
    expect((loader.modules.get('dev-reload-2') as { version: number }).version).toBe(2);

    // No dev-reload copy left behind in the extension's own engine/ directory.
    const leftovers = readdirSync(join(extDir, 'engine')).filter((f) =>
      f.includes('zveltio-dev-reload'),
    );
    expect(leftovers).toEqual([]);
  });

  /**
   * The same claim as the test above, made deterministic.
   *
   * The copy's name was `.<stem>.zveltio-dev-reload.<Date.now()>.js`, so two
   * loads inside ONE millisecond produced the same path and the second
   * `import()` was served from Bun's module cache — the old code, silently,
   * which is precisely what the copy exists to prevent.
   *
   * That is timing-dependent, so the test above only caught it on a machine
   * fast enough to do both loads within a millisecond: it failed on CI and
   * never locally. Freezing the clock removes the race from the test and
   * turns "sometimes red" into "red until fixed".
   */
  it('busts the cache even when both loads fall in the same millisecond', async () => {
    const extBase = mkdtempSync(join(tmpdir(), 'zv-extbase-reload3-'));
    seedCoreDeps(extBase);
    process.env.EXTENSIONS_DIR = extBase;
    process.env.ZVELTIO_EXTENSION_DEV_RELOAD = '1';
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    process.env.NODE_ENV = 'development';

    const extDir = join(extBase, 'dev-reload-3');
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({ name: 'dev-reload-3', version: '1.0.0' }),
    );
    const entryPath = join(extDir, 'engine/index.js');
    writeFileSync(
      entryPath,
      `export default { name: 'dev-reload-3', version: 1, async register() {} };`,
    );

    const db = new CannedDb();
    const loader = {
      loaded: new Map(),
      manifestMeta: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx: {
        db: db.kysely,
        fieldTypeRegistry: { register: () => {} },
      } as unknown as ExtensionContext,
    };

    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000; // every load reports the same instant
    try {
      await loadExtensionFromDir(loader as never, 'dev-reload-3', new Hono(), loader.ctx, extBase);
      expect((loader.modules.get('dev-reload-3') as { version: number }).version).toBe(1);

      writeFileSync(
        entryPath,
        `export default { name: 'dev-reload-3', version: 2, async register() {} };`,
      );
      loader.loaded.delete('dev-reload-3');
      loader.modules.delete('dev-reload-3');

      await loadExtensionFromDir(loader as never, 'dev-reload-3', new Hono(), loader.ctx, extBase);
      expect((loader.modules.get('dev-reload-3') as { version: number }).version).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });
});
