import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordBundledVersions } from './extension-pack.js';

/**
 * `check-embedded-deps-fresh` reads a bundled dependency's version from the
 * bundler's path comments, and a hoisted `node_modules/<name>/` path names
 * none. kysely and @hono/zod-validator are inlined that way in every committed
 * extension bundle, so the gate could not check them. `pack` now records them.
 */
function fixture(bundle: string) {
  const root = mkdtempSync(join(tmpdir(), 'zv-bundled-'));
  const ext = join(root, 'group', 'ext');
  mkdirSync(join(ext, 'engine'), { recursive: true });
  // Hoisted at the repo root, where the bundler resolved it from.
  mkdirSync(join(root, 'node_modules', 'kysely'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'kysely', 'package.json'), '{"version":"0.29.6"}');
  const outfile = join(ext, 'engine', 'index.js');
  writeFileSync(outfile, bundle);
  return { ext, outfile };
}

describe('recordBundledVersions', () => {
  test('records a dependency inlined from a hoisted tree', () => {
    const { ext, outfile } = fixture(
      '// /zveltio-extension/node_modules/kysely/dist/index.js\nexport {};\n',
    );
    expect(recordBundledVersions(outfile, ext)).toEqual(['kysely@0.29.6']);
    expect(readFileSync(outfile, 'utf8')).toEndWith('// @zveltio-bundled kysely@0.29.6\n');
  });

  test('leaves a dependency whose store path already names its version', () => {
    const { ext, outfile } = fixture(
      '// /zveltio-extension/.bun/kysely@0.29.6/node_modules/kysely/dist/index.js\nexport {};\n',
    );
    expect(recordBundledVersions(outfile, ext)).toEqual([]);
  });

  test('records nothing for a dependency the bundle does not inline', () => {
    const { ext, outfile } = fixture('export {};\n');
    expect(recordBundledVersions(outfile, ext)).toEqual([]);
    expect(readFileSync(outfile, 'utf8')).toBe('export {};\n');
  });
});
