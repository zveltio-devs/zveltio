/**
 * maybeSymlinkNodeModules — non-fatal symlink failure (extension-deps.ts).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { maybeSymlinkNodeModules } from '../../lib/extensions/extension-deps.js';

let extBase: string;
let workCwd: string;
let originalCwd: string;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-symlink-ext-'));
  workCwd = mkdtempSync(join(tmpdir(), 'zveltio-symlink-cwd-'));
  originalCwd = process.cwd();
  process.chdir(workCwd);
  mkdirSync(join(extBase, 'node_modules'), { recursive: true });
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

describe('maybeSymlinkNodeModules — symlink failure', () => {
  it('warns when symlinkSync throws but does not throw itself', () => {
    const symlinkSpy = spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      maybeSymlinkNodeModules(extBase);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('failed to symlink'))).toBe(true);
      expect(existsSync(join(workCwd, 'node_modules'))).toBe(false);
    } finally {
      symlinkSpy.mockRestore();
      warn.mockRestore();
    }
  });
});
