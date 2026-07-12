/**
 * Extension peerDependency installer (lib/extensions/npm-install.ts).
 *
 * Uses a temp EXTENSIONS_DIR — no real bun/npm spawn in the happy-path
 * early-return case; validation failures are pure.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installExtensionNpmDependencies } from '../../lib/extensions/npm-install.js';

let extBase: string;
let savedExtensionsDir: string | undefined;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-npm-install-'));
  savedExtensionsDir = process.env.EXTENSIONS_DIR;
  process.env.EXTENSIONS_DIR = extBase;
});

afterEach(() => {
  if (savedExtensionsDir === undefined) delete process.env.EXTENSIONS_DIR;
  else process.env.EXTENSIONS_DIR = savedExtensionsDir;
});

describe('installExtensionNpmDependencies', () => {
  it('returns immediately when every peer is already on disk', async () => {
    mkdirSync(join(extBase, 'node_modules', 'hono'), { recursive: true });
    writeFileSync(join(extBase, 'node_modules', 'hono', 'package.json'), '{}');
    await expect(
      installExtensionNpmDependencies('probe', { hono: '^4.0.0' }),
    ).resolves.toBeUndefined();
  });

  it('rejects unsafe package names before spawning', async () => {
    await expect(
      installExtensionNpmDependencies('evil', { 'foo;rm -rf': '^1.0.0' }),
    ).rejects.toThrow(/unsafe peerDependency/i);
  });

  it('rejects packages outside the platform allow-list', async () => {
    await expect(
      installExtensionNpmDependencies('evil', { 'not-on-allowlist-xyz': '^1.0.0' }),
    ).rejects.toThrow(/allow-list/i);
  });

  it('installs missing allow-listed peers via bun add', async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === 'bun' && cmd[1] === 'add') {
        const pkg = cmd[2]!.startsWith('nanoid@') ? 'nanoid' : cmd[2]!.split('@')[0]!;
        const dest = join(extBase, 'node_modules', pkg);
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

  it('falls back to npm install when bun add exits non-zero', async () => {
    const originalSpawn = Bun.spawn;
    let npmCalled = false;
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === 'bun' && cmd[1] === 'add') {
        return {
          exited: Promise.resolve(1),
          stdout: new ReadableStream(),
          stderr: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('peer conflict'));
              c.close();
            },
          }),
        } as ReturnType<typeof Bun.spawn>;
      }
      if (cmd[0] === 'npm') {
        npmCalled = true;
        mkdirSync(join(extBase, 'node_modules', 'nanoid'), { recursive: true });
        writeFileSync(join(extBase, 'node_modules', 'nanoid', 'package.json'), '{}');
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
      expect(npmCalled).toBe(true);
      expect(existsSync(join(extBase, 'node_modules', 'nanoid'))).toBe(true);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it('warns when npm install exits non-zero after bun add fails', async () => {
    const originalSpawn = Bun.spawn;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warns.push(a.join(' '));
    const closedStream = () =>
      new ReadableStream({
        start(c) {
          c.close();
        },
      });
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === 'bun' && cmd[1] === 'add') {
        return {
          exited: Promise.resolve(1),
          stdout: closedStream(),
          stderr: closedStream(),
        } as ReturnType<typeof Bun.spawn>;
      }
      if (cmd[0] === 'npm') {
        return {
          exited: Promise.resolve(1),
          stdout: closedStream(),
          stderr: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('peer not found'));
              c.close();
            },
          }),
        } as ReturnType<typeof Bun.spawn>;
      }
      return originalSpawn(cmd as never);
    }) as typeof Bun.spawn;

    try {
      await expect(
        installExtensionNpmDependencies('mail-ext', { nanoid: '^5.0.0' }),
      ).rejects.toThrow(/could not install peer packages/i);
      expect(warns.join('\n')).toMatch(/npm install failed for "mail-ext"/);
      expect(warns.join('\n')).toMatch(/peer not found/);
    } finally {
      Bun.spawn = originalSpawn;
      console.warn = origWarn;
    }
  });

  it('throws when neither bun nor npm can install missing peers', async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = (() => {
      throw new Error('ENOENT');
    }) as typeof Bun.spawn;
    try {
      await expect(
        installExtensionNpmDependencies('mail-ext', { nanoid: '^5.0.0' }),
      ).rejects.toThrow(/could not install peer packages/i);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
