/**
 * npm tarball fallback in ensureExtensionCoreDeps (extension-deps.ts).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CORE_NPM_PACKAGES, ensureExtensionCoreDeps } from '../../lib/extensions/extension-deps.js';

let extBase: string;
let originalFetch: typeof fetch;
let originalSpawn: typeof Bun.spawn;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-deps-tar-'));
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

describe('ensureExtensionCoreDeps npm tarball fallback', () => {
  it('installs core packages via registry tarballs when bun install fails', async () => {
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === 'bun') {
        return {
          exited: Promise.resolve(1),
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
        } as ReturnType<typeof Bun.spawn>;
      }
      if (cmd[0] === 'tar') {
        return {
          exited: Promise.resolve(0),
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
        } as ReturnType<typeof Bun.spawn>;
      }
      return originalSpawn(cmd as never);
    }) as typeof Bun.spawn;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org') && url.endsWith('/latest')) {
        const pkg = url.split('/').slice(-2, -1)[0]!;
        return {
          ok: true,
          json: async () => ({
            version: '9.9.9',
            dist: { tarball: `https://registry.npmjs.org/${pkg}/-/${pkg}-9.9.9.tgz` },
          }),
        } as Response;
      }
      if (url.endsWith('.tgz')) {
        return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response;
      }
      return originalFetch(input);
    }) as typeof fetch;

    await ensureExtensionCoreDeps(extBase);

    for (const pkg of CORE_NPM_PACKAGES) {
      const folder = pkg.startsWith('@') ? pkg : pkg.split('/')[0]!;
      expect(existsSync(join(extBase, 'node_modules', folder))).toBe(true);
    }
  });
});
