import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionPackCommand, hashSchemaFiles } from './extension-pack.js';

/**
 * The engine's `schemaDigest` pins the same vector (ext-schema-integrity.test.ts):
 * the two computations live in packages that cannot import each other.
 */
const GOLDEN = {
  files: { 'collections/a.json': '{"name":"a"}\n', 'migrations/20261029T000000-x.json': '{}' },
  digest: '9346cfe3eb9c3949318c84e1a0b105ac294f420481ce6c1edd365ec35fdc4f13',
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(manifest: Record<string, unknown>, engine?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-pack-schema-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', ...manifest }),
  );
  for (const [rel, content] of Object.entries(GOLDEN.files)) {
    mkdirSync(join(dir, 'schema', rel, '..'), { recursive: true });
    writeFileSync(join(dir, 'schema', rel), content);
  }
  if (engine) {
    mkdirSync(join(dir, 'engine'));
    writeFileSync(join(dir, 'engine/index.ts'), engine);
  }
  return dir;
}

const integrity = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).integrity as Record<string, string>;

describe('extension pack records integrity.schemaSha256 (ADR 0012)', () => {
  it('hashes every .json under schema/, by path and bytes', () => {
    expect(hashSchemaFiles(fixture({}))).toBe(GOLDEN.digest);
  });

  it('a Studio-only extension that declares collections gets the digest alone', async () => {
    const dir = fixture({ collections: ['a'], contributes: { engine: false } });
    await extensionPackCommand({ dir });
    expect(integrity(dir)).toEqual({ schemaSha256: GOLDEN.digest });
  });

  it('a bundled extension gets it beside its bundle hashes', async () => {
    const dir = fixture({ collections: ['a'] }, 'export default { name: "x" };\n');
    await extensionPackCommand({ dir, firstParty: true });
    expect(integrity(dir)).toMatchObject({ schemaSha256: GOLDEN.digest });
    expect(integrity(dir).engineSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);

  it('an extension that declares none gets no digest, and without an engine needs no pack', async () => {
    const dir = fixture({}, 'export default { name: "x" };\n');
    await extensionPackCommand({ dir, firstParty: true });
    expect(integrity(dir).schemaSha256).toBeUndefined();
    await expect(extensionPackCommand({ dir: fixture({}) })).rejects.toThrow(/don't need pack/);
  }, 30_000);
});
