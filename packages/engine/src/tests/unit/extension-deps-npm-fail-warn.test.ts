/**
 * ensureExtensionCoreDeps — bun + npm tarball both fail (extension-deps.ts).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { ensureExtensionCoreDeps } from '../../lib/extensions/extension-deps.js';

let extBase: string;
let originalFetch: typeof fetch;
let originalSpawn: typeof Bun.spawn;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-deps-fail-'));
  originalFetch = globalThis.fetch;
  originalSpawn = Bun.spawn;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  try {
    rmSync(extBase, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('ensureExtensionCoreDeps — install failure', () => {
  it('warns when bun install and npm tarball fetch both fail', async () => {
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === 'bun') {
        return {
          exited: Promise.resolve(1),
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
        } as ReturnType<typeof Bun.spawn>;
      }
      return originalSpawn(cmd as never);
    }) as typeof Bun.spawn;

    globalThis.fetch = (async () => {
      throw new Error('registry unreachable');
    }) as unknown as typeof fetch;

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(ensureExtensionCoreDeps(extBase)).resolves.toBeUndefined();
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('Core package install failed')),
      ).toBe(true);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('Extensions with engine routes')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
