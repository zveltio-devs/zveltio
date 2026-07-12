/**
 * ensureExtensionCoreDeps — skips install when hono already exists (extension-deps.ts).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { ensureExtensionCoreDeps } from '../../lib/extensions/extension-deps.js';

let extBase: string;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-deps-skip-'));
  mkdirSync(join(extBase, 'node_modules', 'hono'), { recursive: true });
  writeFileSync(join(extBase, 'node_modules', 'hono', 'package.json'), '{"name":"hono"}');
});

afterEach(() => {
  try {
    rmSync(extBase, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('ensureExtensionCoreDeps — hono already present', () => {
  it('does not run bun install when core packages are already installed', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('spawn should not be called');
    });
    try {
      await ensureExtensionCoreDeps(extBase);
      expect(existsSync(join(extBase, 'node_modules', 'hono'))).toBe(true);
      expect(log.mock.calls.some((c) => String(c[0]).includes('Installing core packages'))).toBe(
        false,
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      spawnSpy.mockRestore();
    }
  });
});
