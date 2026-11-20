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
import { exportTrustedKeyEntry, generateKeypair, signBundle } from '@zveltio/sdk/publish';
import { downloadExtension } from '../../lib/extensions/extension-download.js';
import { REGISTRY_SIGNED_DIR } from '../../lib/security/index.js';

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
const savedKeys = process.env.REGISTRY_PUBLIC_KEYS_JSON;
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
  // Signed as the registry signs: there is no unsigned install.
  const kp = await generateKeypair('race-registry');
  process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
    await exportTrustedKeyEntry(kp.keyId, kp.publicJwk),
  ]);
  const sig = await signBundle(new Uint8Array(archive), kp);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('.sig')) return Response.json(sig);
    return new Response(new Uint8Array(archive));
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (savedKeys === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
  else process.env.REGISTRY_PUBLIC_KEYS_JSON = savedKeys;
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
    expect(readdirSync(dir).sort()).toEqual([REGISTRY_SIGNED_DIR, 'engine', 'manifest.json']);
    expect(readdirSync(join(dir, 'engine'))).toHaveLength(FILES);
    for (let i = 0; i < FILES; i++)
      expect(readFileSync(join(dir, 'engine', `f${i}.js`), 'utf8')).toBe(body(i));
    // Nothing of a staging area left beside the extension either.
    expect(readdirSync(base)).toEqual([ENTRY.name]);
  }
}, 60_000);
