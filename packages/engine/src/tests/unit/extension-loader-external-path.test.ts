/**
 * ExtensionLoader.loadAll — ZVELTIO_EXTENSIONS_PATH external discovery.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('ExtensionLoader.loadAll — external path', () => {
  it('loads extensions discovered under ZVELTIO_EXTENSIONS_PATH', async () => {
    savedExtensions = process.env.ZVELTIO_EXTENSIONS;
    savedExternalPath = process.env.ZVELTIO_EXTENSIONS_PATH;
    process.env.ZVELTIO_EXTENSIONS = 'bundled-one';

    const extRoot = mkdtempSync(join(tmpdir(), 'zv-extpath-'));
    // A directory with a manifest is an extension, at any depth; one without
    // is a category; node_modules and dot-named directories are neither.
    for (const dir of [
      'external-a',
      'external-b',
      'cat/external-c',
      'node_modules/dep',
      '.staging-x',
    ]) {
      mkdirSync(join(extRoot, dir), { recursive: true });
      writeFileSync(join(extRoot, dir, 'manifest.json'), '{}');
    }
    mkdirSync(join(extRoot, 'external-a', 'nested'));
    writeFileSync(join(extRoot, 'external-a', 'nested', 'manifest.json'), '{}');
    process.env.ZVELTIO_EXTENSIONS_PATH = extRoot;

    const loader = new ExtensionLoader();
    const calls: Array<{ name: string; basePath?: string }> = [];
    loader.loadExtension = async (name, _app, _ctx, basePath) => {
      calls.push({ name, basePath });
      loader.loaded.set(name, { registeredRoutes: false } as never);
    };
    loader.topoSortExtensions = async (names) => names;

    await loader.loadAll(noApp, { db: new CannedDb().kysely } as ExtensionContext);

    expect(calls.find((c) => c.name === 'bundled-one')?.basePath).toBeUndefined();
    const external = calls
      .filter((c) => c.basePath === extRoot)
      .map((c) => c.name)
      .sort();
    expect(external).toEqual(['cat/external-c', 'external-a', 'external-b']);
  });

  it('sorts the external extensions with the rest: a dependency there loads first', async () => {
    savedExtensions = process.env.ZVELTIO_EXTENSIONS;
    savedExternalPath = process.env.ZVELTIO_EXTENSIONS_PATH;
    const savedDir = process.env.EXTENSIONS_DIR;
    const base = mkdtempSync(join(tmpdir(), 'zv-extbase-'));
    mkdirSync(join(base, 'needs-ext'));
    writeFileSync(
      join(base, 'needs-ext', 'manifest.json'),
      JSON.stringify({ name: 'needs-ext', dependencies: [{ name: 'external-dep' }] }),
    );
    const extRoot = mkdtempSync(join(tmpdir(), 'zv-extpath-'));
    mkdirSync(join(extRoot, 'external-dep'));
    writeFileSync(join(extRoot, 'external-dep', 'manifest.json'), '{}');
    process.env.EXTENSIONS_DIR = base;
    process.env.ZVELTIO_EXTENSIONS = 'needs-ext';
    process.env.ZVELTIO_EXTENSIONS_PATH = extRoot;
    try {
      const loader = new ExtensionLoader();
      const order: string[] = [];
      loader.loadExtension = async (name) => {
        order.push(name);
        loader.loaded.set(name, { registeredRoutes: false } as never);
      };
      await loader.loadAll(noApp, { db: new CannedDb().kysely } as ExtensionContext);
      expect(order).toEqual(['external-dep', 'needs-ext']);
    } finally {
      if (savedDir === undefined) delete process.env.EXTENSIONS_DIR;
      else process.env.EXTENSIONS_DIR = savedDir;
    }
  });
});
