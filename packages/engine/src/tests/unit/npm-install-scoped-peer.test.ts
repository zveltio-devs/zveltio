/**
 * installExtensionNpmDependencies — scoped package folder resolution (@scope/pkg).
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installExtensionNpmDependencies } from '../../lib/extensions/npm-install.js';

let extBase: string;
let savedExtensionsDir: string | undefined;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-npm-scoped-'));
  savedExtensionsDir = process.env.EXTENSIONS_DIR;
  process.env.EXTENSIONS_DIR = extBase;
});

afterEach(() => {
  if (savedExtensionsDir === undefined) delete process.env.EXTENSIONS_DIR;
  else process.env.EXTENSIONS_DIR = savedExtensionsDir;
});

describe('installExtensionNpmDependencies — scoped peers', () => {
  it('skips install when a scoped package folder already exists', async () => {
    const scopedDir = join(extBase, 'node_modules', '@zveltio', 'test-pkg');
    mkdirSync(scopedDir, { recursive: true });
    writeFileSync(join(scopedDir, 'package.json'), '{}');

    let spawnCalled = false;
    const originalSpawn = Bun.spawn;
    Bun.spawn = (() => {
      spawnCalled = true;
      throw new Error('should not spawn');
    }) as typeof Bun.spawn;

    try {
      await expect(
        installExtensionNpmDependencies('scoped-ext', { '@zveltio/test-pkg': '^1.0.0' }),
      ).resolves.toBeUndefined();
      expect(spawnCalled).toBe(false);
      expect(existsSync(join(scopedDir, 'package.json'))).toBe(true);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('installs a missing scoped peer via bun add', async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === 'bun' && cmd[1] === 'add' && cmd[2] === 'nanoid@5.0.0') {
        const dest = join(extBase, 'node_modules', 'nanoid');
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, 'package.json'), '{}');
        return {
          exited: Promise.resolve(0),
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
        } as ReturnType<typeof Bun.spawn>;
      }
      return originalSpawn(cmd as never);
    }) as typeof Bun.spawn;

    try {
      await installExtensionNpmDependencies('mail-ext', { nanoid: '^5.0.0' });
      expect(existsSync(join(extBase, 'node_modules', 'nanoid'))).toBe(true);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
