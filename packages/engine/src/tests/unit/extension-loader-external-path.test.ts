/**
 * ExtensionLoader.loadAll — ZVELTIO_EXTENSIONS_PATH external discovery.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
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
    mkdirSync(join(extRoot, 'external-a'));
    mkdirSync(join(extRoot, 'external-b'));
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
    expect(external).toEqual(['external-a', 'external-b']);
  });
});
