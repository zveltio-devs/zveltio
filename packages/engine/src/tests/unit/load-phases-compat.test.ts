/**
 * resolveManifest compatibility + resolveEntryPath dev paths (load-phases.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEntryPath, resolveManifest } from '../../lib/extensions/load-phases.js';
import { CORE_NPM_PACKAGES } from '../../lib/extensions/extension-deps.js';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const db = {} as Database;

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-ext-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

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
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveManifest — version + postgres extension branches', () => {
  it('fails when zveltioMaxVersion is below the running engine', async () => {
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        zveltioMinVersion: '1.0.0',
        zveltioMaxVersion: '0.0.1',
      }),
    });
    const r = await resolveManifest('probe', dir, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.logArgs.join(' ')).toContain('incompatible');
  });

  it('continues when all declared postgres extensions are installed', async () => {
    const canned = new CannedDb();
    canned.when(/pg_extension/i, [{ extname: 'postgis' }]);
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        requires: { postgres_extensions: ['postgis'] },
      }),
    });
    const r = await resolveManifest('probe', dir, canned.kysely as unknown as Database);
    expect(r.ok).toBe(true);
  });
});

describe('resolveEntryPath — legacy dev reload', () => {
  it('allows unbundled extensions when dev reload is enabled and core deps exist', async () => {
    const extBase = mkdtempSync(join(tmpdir(), 'zv-extbase-'));
    seedCoreDeps(extBase);
    process.env.EXTENSIONS_DIR = extBase;
    process.env.ZVELTIO_EXTENSION_DEV_RELOAD = '1';
    process.env.NODE_ENV = 'development';

    const extDir = tmpExt({ 'engine/index.js': 'export default {}' });
    const enginePath = join(extDir, 'engine/index.js');
    const r = await resolveEntryPath('dev-ext', extDir, enginePath, {
      name: 'dev-ext',
      version: '1.0.0',
    } as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(enginePath);
  });

  it('fails when core npm packages are missing from EXTENSIONS_DIR', async () => {
    const extBase = mkdtempSync(join(tmpdir(), 'zv-extbase-empty-'));
    process.env.EXTENSIONS_DIR = extBase;
    process.env.ZVELTIO_EXTENSION_DEV_RELOAD = '1';
    process.env.NODE_ENV = 'development';

    const extDir = tmpExt({ 'engine/index.js': 'export default {}' });
    const r = await resolveEntryPath('dev-ext', extDir, join(extDir, 'engine/index.js'), {
      name: 'dev-ext',
      version: '1.0.0',
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('Core package');
    expect(existsSync(join(extBase, 'node_modules'))).toBe(false);
  });
});
