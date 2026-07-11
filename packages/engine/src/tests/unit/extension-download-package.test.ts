/**
 * Package download client (lib/extensions/extension-download.ts) — downloadExtension
 * error paths + ZIP extract happy path. fetchWithRetry is driven via globalThis.fetch;
 * archive extraction via a Bun.spawn stub (no real unzip binary required).
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { downloadExtension } from '../../lib/extensions/extension-download.js';
import { SignatureMissingError } from '../../lib/security/index.js';

const ENTRY = {
  name: 'pkg-test',
  displayName: 'Pkg Test',
  description: '',
  category: 'other' as const,
  version: '1.0.0',
  author: 'test',
  tags: [] as string[],
  permissions: [] as string[],
  download_url: 'https://registry.test/api/extensions/by-name/pkg-test/download',
  is_official: true,
};

/** Smallest valid ZIP local-file header + EOCD (empty archive still has PK magic). */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);

let originalFetch: typeof fetch;
let originalSpawn: typeof Bun.spawn;
let destBase: string;
let savedRequireSig: string | undefined;

function mockProc(exitCode: number) {
  return {
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
  };
}

function stubDownloadResponse(
  body: Buffer,
  opts: { ok?: boolean; status?: number; text?: string; sha?: string | null } = {},
): void {
  const { ok = true, status = 200, text = '', sha = null } = opts;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('.sig')) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as Response;
    }
    const headers = new Headers();
    if (sha) headers.set('x-archive-sha256', sha);
    return {
      ok,
      status,
      headers,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => text,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalSpawn = Bun.spawn;
  destBase = mkdtempSync(join(tmpdir(), 'zveltio-dl-'));
  savedRequireSig = process.env.REQUIRE_EXTENSION_SIGNATURES;
  delete process.env.REQUIRE_EXTENSION_SIGNATURES;

  Bun.spawn = ((cmd: string[], opts?: { cwd?: string }) => {
    if (cmd[0] === 'unzip') {
      const destIdx = cmd.indexOf('-d');
      const stageDir = destIdx >= 0 ? cmd[destIdx + 1]! : join(destBase, ENTRY.name, '_stage');
      const engineDir = join(stageDir, 'engine');
      mkdirSync(engineDir, { recursive: true });
      writeFileSync(join(stageDir, 'manifest.json'), '{}');
      writeFileSync(join(engineDir, 'index.ts'), 'export default {}');
      return mockProc(0) as ReturnType<typeof Bun.spawn>;
    }
    if (cmd[0] === 'tar') return mockProc(0) as ReturnType<typeof Bun.spawn>;
    return originalSpawn(cmd, opts as never);
  }) as typeof Bun.spawn;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  if (savedRequireSig === undefined) delete process.env.REQUIRE_EXTENSION_SIGNATURES;
  else process.env.REQUIRE_EXTENSION_SIGNATURES = savedRequireSig;
  try {
    rmSync(destBase, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('downloadExtension', () => {
  it('throws a marketplace-review message on 403 not-yet-published', async () => {
    stubDownloadResponse(Buffer.alloc(0), {
      ok: false,
      status: 403,
      text: 'Extension is not yet published to the marketplace',
    });
    await expect(downloadExtension(ENTRY, destBase)).rejects.toThrow(/not yet approved/i);
  });

  it('throws on an empty downloaded archive', async () => {
    stubDownloadResponse(Buffer.from([1, 2]));
    await expect(downloadExtension(ENTRY, destBase)).rejects.toThrow(/Empty package/i);
  });

  it('refuses extraction when X-Archive-Sha256 does not match the bytes', async () => {
    const body = Buffer.concat([ZIP_MAGIC, Buffer.from('payload')]);
    stubDownloadResponse(body, { sha: createHash('sha256').update('other').digest('hex') });
    await expect(downloadExtension(ENTRY, destBase)).rejects.toThrow(/SHA-256 mismatch/i);
  });

  it('throws SignatureMissingError when signatures are required but absent', async () => {
    process.env.REQUIRE_EXTENSION_SIGNATURES = 'true';
    stubDownloadResponse(ZIP_MAGIC);
    await expect(downloadExtension(ENTRY, destBase)).rejects.toBeInstanceOf(SignatureMissingError);
  });

  it('rejects unknown archive magic', async () => {
    stubDownloadResponse(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    await expect(downloadExtension(ENTRY, destBase)).rejects.toThrow(/Unknown archive format/i);
  });

  it('extracts a ZIP archive into the destination directory', async () => {
    stubDownloadResponse(ZIP_MAGIC);
    await downloadExtension(ENTRY, destBase, 'license-token-abc');
    const manifest = join(destBase, ENTRY.name, 'manifest.json');
    const engine = join(destBase, ENTRY.name, 'engine', 'index.ts');
    expect(existsSync(manifest)).toBe(true);
    expect(existsSync(engine)).toBe(true);
    expect(readFileSync(engine, 'utf8')).toContain('export default');
  });

  it('passes the license key as Authorization Bearer on download', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('.sig')) {
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
      }
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer lic-xyz');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => ZIP_MAGIC.buffer,
        text: async () => '',
      } as Response;
    }) as typeof fetch;
    await downloadExtension(ENTRY, destBase, 'lic-xyz');
    expect(urls.some((u) => u.includes('/download'))).toBe(true);
  });
});
