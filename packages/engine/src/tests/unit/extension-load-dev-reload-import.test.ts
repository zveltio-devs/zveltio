/**
 * load.ts — unbundled extension import with ZVELTIO_EXTENSION_DEV_RELOAD cache buster.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
      ctx: {
        db: db.kysely,
        fieldTypeRegistry: { register: () => {} },
      } as unknown as ExtensionContext,
    };

    await loadExtensionFromDir(loader as never, 'dev-reload', new Hono(), loader.ctx, extBase);
    expect(loader.loaded.has('dev-reload')).toBe(true);
    expect(loader.lastLoadError.get('dev-reload')).toBeUndefined();
  });
});
