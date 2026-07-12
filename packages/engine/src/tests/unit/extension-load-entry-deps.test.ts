/**
 * loadExtensionFromDir — resolveEntryPath failure when core deps are missing (load.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadExtensionFromDir } from '../../lib/extensions/load.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { CannedDb } from './fixtures/canned-db.js';

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-entry-deps-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

let savedExtDir: string | undefined;
let savedDevReload: string | undefined;
let savedNodeEnv: string | undefined;
let savedInline: string | undefined;

afterEach(() => {
  if (savedExtDir === undefined) delete process.env.EXTENSIONS_DIR;
  else process.env.EXTENSIONS_DIR = savedExtDir;
  if (savedDevReload === undefined) delete process.env.ZVELTIO_EXTENSION_DEV_RELOAD;
  else process.env.ZVELTIO_EXTENSION_DEV_RELOAD = savedDevReload;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedInline === undefined) delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
  else process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = savedInline;
});

describe('loadExtensionFromDir — entry path failure', () => {
  it('records lastLoadError when dev reload is on but core npm packages are absent', async () => {
    savedExtDir = process.env.EXTENSIONS_DIR;
    savedDevReload = process.env.ZVELTIO_EXTENSION_DEV_RELOAD;
    savedNodeEnv = process.env.NODE_ENV;
    savedInline = process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
    process.env.EXTENSIONS_DIR = mkdtempSync(join(tmpdir(), 'zv-extbase-empty-'));
    process.env.ZVELTIO_EXTENSION_DEV_RELOAD = '1';
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    process.env.NODE_ENV = 'development';

    const base = tmpExt({
      'dev-ext/manifest.json': JSON.stringify({ name: 'dev-ext', version: '1.0.0' }),
      'dev-ext/engine/index.js': 'export default { async register(){} };',
    });
    const loader = {
      loaded: new Map(),
      manifestMeta: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      ctx: { db: new CannedDb().kysely } as ExtensionContext,
    };
    await loadExtensionFromDir(loader as never, 'dev-ext', new Hono(), loader.ctx, base);
    expect(loader.lastLoadError.get('dev-ext')).toContain('Core package');
    expect(loader.loaded.has('dev-ext')).toBe(false);
  });
});
