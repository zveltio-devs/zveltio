/**
 * Extension core dependency provisioning (lib/extensions/extension-deps.ts).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  CORE_NPM_PACKAGES,
  ensureExtensionCoreDeps,
  maybeSymlinkNodeModules,
} from '../../lib/extensions/extension-deps.js';

let extBase: string;
let workCwd: string;
let originalCwd: string;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-ext-deps-'));
  workCwd = mkdtempSync(join(tmpdir(), 'zveltio-ext-cwd-'));
  originalCwd = process.cwd();
  process.chdir(workCwd);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of [extBase, workCwd]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

describe('maybeSymlinkNodeModules', () => {
  it('creates a cwd node_modules symlink to the extensions base', () => {
    mkdirSync(join(extBase, 'node_modules', 'hono'), { recursive: true });
    maybeSymlinkNodeModules(extBase);
    expect(existsSync(join(workCwd, 'node_modules', 'hono'))).toBe(true);
  });

  it('is a no-op when cwd already has node_modules', () => {
    mkdirSync(join(extBase, 'node_modules'), { recursive: true });
    mkdirSync(join(workCwd, 'node_modules'), { recursive: true });
    writeMarker(join(workCwd, 'node_modules', '.marker'));
    maybeSymlinkNodeModules(extBase);
    expect(existsSync(join(workCwd, 'node_modules', '.marker'))).toBe(true);
  });
});

describe('ensureExtensionCoreDeps', () => {
  it('returns immediately when hono is already installed', async () => {
    mkdirSync(join(extBase, 'node_modules', 'hono', 'package.json'), { recursive: true });
    await expect(ensureExtensionCoreDeps(extBase)).resolves.toBeUndefined();
    expect(existsSync(join(workCwd, 'node_modules', 'hono'))).toBe(true);
  });

  it('writes package.json and runs bun install when hono is missing', async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === 'bun' && cmd[1] === 'install') {
        mkdirSync(join(extBase, 'node_modules', 'hono'), { recursive: true });
        writeFileSync(join(extBase, 'node_modules', 'hono', 'package.json'), '{}');
        return {
          exited: Promise.resolve(0),
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
        } as ReturnType<typeof Bun.spawn>;
      }
      return originalSpawn(cmd as never);
    }) as typeof Bun.spawn;
    try {
      await ensureExtensionCoreDeps(extBase);
      expect(existsSync(join(extBase, 'package.json'))).toBe(true);
      expect(existsSync(join(extBase, 'node_modules', 'hono'))).toBe(true);
      expect(existsSync(join(workCwd, 'node_modules', 'hono'))).toBe(true);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});

describe('CORE_NPM_PACKAGES', () => {
  it('lists the four engine runtime packages extensions may import', () => {
    expect(CORE_NPM_PACKAGES).toEqual(['hono', 'zod', 'kysely', '@hono/zod-validator']);
  });
});

function writeMarker(path: string): void {
  writeFileSync(path, '1');
}
