/**
 * Two replicas booting onto one shared, empty EXTENSIONS_DIR fetch the same
 * bundle at once, with no lock between them (extension-loader.ts `loadFromDB`).
 * Each download must still land whole: it stages and extracts on its own, so
 * one never deletes, truncates or moves the other's half-extracted files.
 */

import { afterAll, beforeAll, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadExtension } from '../../lib/extensions/extension-download.js';

const ENTRY = {
  name: 'race-ext',
  displayName: 'Race',
  description: '',
  category: 'other' as const,
  version: '1.0.0',
  author: 'test',
  tags: [] as string[],
  permissions: [] as string[],
  download_url: 'https://registry.test/api/extensions/by-name/race-ext/download',
  is_official: true,
};
const FILES = 400;
const body = (i: number) => `export const v${i} = '${String(i).repeat(2000)}';\n`;

const realFetch = globalThis.fetch;
const savedSig = process.env.REQUIRE_EXTENSION_SIGNATURES;
let work = '';
let archive: Buffer;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'zv-dl-race-'));
  const src = join(work, 'src');
  mkdirSync(join(src, 'engine'), { recursive: true });
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ name: ENTRY.name }));
  for (let i = 0; i < FILES; i++) writeFileSync(join(src, 'engine', `f${i}.js`), body(i));
  const tgz = join(work, 'b.tar.gz');
  expect(await Bun.spawn(['tar', '-czf', tgz, '-C', src, '.']).exited).toBe(0);
  archive = readFileSync(tgz);
  // Mechanics, not signature policy (covered in extension-download-package.test.ts).
  process.env.REQUIRE_EXTENSION_SIGNATURES = 'false';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('.sig')) return new Response('', { status: 404 });
    return new Response(new Uint8Array(archive));
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (savedSig === undefined) delete process.env.REQUIRE_EXTENSION_SIGNATURES;
  else process.env.REQUIRE_EXTENSION_SIGNATURES = savedSig;
  rmSync(work, { recursive: true, force: true });
});

it('two concurrent downloads into one directory both succeed and leave the bundle whole', async () => {
  for (let round = 0; round < 5; round++) {
    const base = join(work, `dest${round}`);
    mkdirSync(base);
    const results = await Promise.allSettled([
      downloadExtension(ENTRY, base),
      downloadExtension(ENTRY, base),
      downloadExtension(ENTRY, base),
    ]);
    expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok'))).toEqual([
      'ok',
      'ok',
      'ok',
    ]);
    const dir = join(base, ENTRY.name);
    expect(readdirSync(dir).sort()).toEqual(['engine', 'manifest.json']);
    expect(readdirSync(join(dir, 'engine'))).toHaveLength(FILES);
    for (let i = 0; i < FILES; i++)
      expect(readFileSync(join(dir, 'engine', `f${i}.js`), 'utf8')).toBe(body(i));
    // Nothing of a staging area left beside the extension either.
    expect(readdirSync(base)).toEqual([ENTRY.name]);
  }
}, 60_000);
