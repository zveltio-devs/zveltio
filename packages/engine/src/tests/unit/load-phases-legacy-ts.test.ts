/**
 * resolveEntryPath — falls back to engine/index.ts when .js is absent (dev reload).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEntryPath } from '../../lib/extensions/load-phases.js';
import { CORE_NPM_PACKAGES } from '../../lib/extensions/extension-deps.js';

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

describe('resolveEntryPath — TypeScript fallback', () => {
  it('resolves engine/index.ts when engine/index.js is missing', async () => {
    const extBase = mkdtempSync(join(tmpdir(), 'zv-tsbase-'));
    seedCoreDeps(extBase);
    process.env.EXTENSIONS_DIR = extBase;
    process.env.ZVELTIO_EXTENSION_DEV_RELOAD = '1';
    process.env.NODE_ENV = 'development';

    const extDir = mkdtempSync(join(tmpdir(), 'zv-ts-ext-'));
    const tsPath = join(extDir, 'engine/index.ts');
    mkdirSync(join(extDir, 'engine'), { recursive: true });
    writeFileSync(tsPath, 'export default {}');

    const engineJsPath = join(extDir, 'engine/index.js');
    const r = await resolveEntryPath('ts-only', extDir, engineJsPath, {
      name: 'ts-only',
      version: '1.0.0',
    } as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(tsPath);
  });
});
