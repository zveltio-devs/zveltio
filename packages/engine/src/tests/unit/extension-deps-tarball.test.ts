/**
 * npm tarball fallback in ensureExtensionCoreDeps (extension-deps.ts).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

  it('falls back to npm tarballs when bun install is not on PATH', async () => {
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === 'bun') {
        throw new Error('ENOENT');
      }
      if (cmd[0] === 'tar') {
        return {
          exited: Promise.resolve(0),
          stdout: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
        } as ReturnType<typeof Bun.spawn>;
      }
      return originalSpawn(cmd as never);
    }) as typeof Bun.spawn;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

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

    try {
      await ensureExtensionCoreDeps(extBase);
      expect(logs.join('\n')).toMatch(/bun CLI unavailable/);
      expect(existsSync(join(extBase, 'node_modules', 'hono'))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  // The cases above stub `tar` and only see the directory mkdirSync made before
  // it ran. This one extracts a real npm-layout tarball (everything under
  // `package/`), which is what a container without the bun CLI does at boot.
  it('extracts a real npm tarball into node_modules/<pkg> and removes the download', async () => {
    const src = mkdtempSync(join(tmpdir(), 'zveltio-deps-tgz-'));
    mkdirSync(join(src, 'package'));
    writeFileSync(join(src, 'package', 'package.json'), '{"name":"fixture","version":"9.9.9"}');
    const tgz = join(src, 'fixture.tgz');
    expect(Bun.spawnSync(['tar', '-czf', tgz, '-C', src, 'package']).exitCode).toBe(0);
    const bytes = readFileSync(tgz);

    Bun.spawn = ((cmd: string[], opts?: unknown) => {
      if (cmd[0] === 'bun') throw new Error('bun: command not found');
      return originalSpawn(cmd as never, opts as never);
    }) as typeof Bun.spawn;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/latest')) {
        return {
          ok: true,
          json: async () => ({ version: '9.9.9', dist: { tarball: 'https://example.test/x.tgz' } }),
        } as Response;
      }
      return { ok: true, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;

    try {
      await ensureExtensionCoreDeps(extBase);
      const modules = join(extBase, 'node_modules');
      for (const pkg of CORE_NPM_PACKAGES) {
        expect(existsSync(join(modules, pkg, 'package.json'))).toBe(true);
      }
      expect(readdirSync(modules).filter((n) => n.endsWith('.tgz'))).toEqual([]);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('keeps a package.json the operator already wrote', async () => {
    const mine = '{"name":"operator-owned","dependencies":{"hono":"4.13.8"}}';
    writeFileSync(join(extBase, 'package.json'), mine);
    Bun.spawn = ((cmd: string[], opts?: unknown) => {
      if (cmd[0] === 'bun') {
        return { exited: Promise.resolve(0) } as ReturnType<typeof Bun.spawn>;
      }
      return originalSpawn(cmd as never, opts as never);
    }) as typeof Bun.spawn;
    await ensureExtensionCoreDeps(extBase);
    expect(readFileSync(join(extBase, 'package.json'), 'utf8')).toBe(mine);
  });
});
