/**
 * extension-deps.ts — npm tarball fallback error branches.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ensureExtensionCoreDeps } from '../../lib/extensions/extension-deps.js';

let extBase: string;
let originalFetch: typeof fetch;
let originalSpawn: typeof Bun.spawn;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-deps-err-'));
  originalFetch = globalThis.fetch;
  originalSpawn = Bun.spawn;
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

describe('ensureExtensionCoreDeps — tarball errors', () => {
  it('warns when npm metadata fetch fails', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(ensureExtensionCoreDeps(extBase)).resolves.toBeUndefined();
  });

  it('warns when tarball download fails', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/latest')) {
        return {
          ok: true,
          json: async () => ({
            version: '1.0.0',
            dist: { tarball: 'https://registry.npmjs.org/hono/-/hono-1.0.0.tgz' },
          }),
        } as Response;
      }
      return { ok: false, status: 500 } as Response;
    }) as typeof fetch;

    await expect(ensureExtensionCoreDeps(extBase)).resolves.toBeUndefined();
  });

  it('warns when tar extraction fails', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/latest')) {
        return {
          ok: true,
          json: async () => ({
            version: '1.0.0',
            dist: { tarball: 'https://registry.npmjs.org/hono/-/hono-1.0.0.tgz' },
          }),
        } as Response;
      }
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response;
    }) as typeof fetch;

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
          exited: Promise.resolve(2),
          stdout: new ReadableStream(),
          stderr: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('tar: invalid archive'));
              c.close();
            },
          }),
        } as ReturnType<typeof Bun.spawn>;
      }
      return originalSpawn(cmd as never);
    }) as typeof Bun.spawn;

    await expect(ensureExtensionCoreDeps(extBase)).resolves.toBeUndefined();
  });
});
