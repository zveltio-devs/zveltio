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
});

describe('CORE_NPM_PACKAGES', () => {
  it('lists the four engine runtime packages extensions may import', () => {
    expect(CORE_NPM_PACKAGES).toEqual(['hono', 'zod', 'kysely', '@hono/zod-validator']);
  });
});

function writeMarker(path: string): void {
  writeFileSync(path, '1');
}
