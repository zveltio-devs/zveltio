/**
 * A bundle that no longer matches its manifest — or its source — must not pass
 * validate. Before this check, `publish --no-pack` archived and signed a stale
 * `engine/index.js` and said nothing.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundleIntegrity } from './extension-validate.js';
import { hashEngineSources } from './extension-pack.js';

function fixture(opts: { bundle: string; source: string }): {
  dir: string;
  integrity: { engineSha256: string; sourceSha256: string };
} {
  const dir = mkdtempSync(join(tmpdir(), 'zv-integrity-'));
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(join(dir, 'engine', 'index.ts'), opts.source);
  writeFileSync(join(dir, 'engine', 'index.js'), opts.bundle);
  return {
    dir,
    integrity: {
      engineSha256: createHash('sha256').update(opts.bundle).digest('hex'),
      sourceSha256: hashEngineSources(dir),
    },
  };
}

describe('checkBundleIntegrity', () => {
  test('passes when bundle and source both match what pack recorded', () => {
    const f = fixture({ bundle: 'export default 1;', source: 'export default 1;' });
    expect(checkBundleIntegrity(f.dir, { integrity: f.integrity })).toEqual([]);
  });

  test('flags a bundle whose bytes changed after pack', () => {
    const f = fixture({ bundle: 'export default 1;', source: 'export default 1;' });
    writeFileSync(join(f.dir, 'engine', 'index.js'), 'export default 2;');
    const codes = checkBundleIntegrity(f.dir, { integrity: f.integrity }).map((e) => e.code);
    expect(codes).toContain('BUNDLE_HASH_MISMATCH');
  });

  test('flags a source edited after the last pack', () => {
    const f = fixture({ bundle: 'export default 1;', source: 'export default 1;' });
    writeFileSync(join(f.dir, 'engine', 'index.ts'), 'export default 1; // security fix');
    const errors = checkBundleIntegrity(f.dir, { integrity: f.integrity });
    expect(errors.map((e) => e.code)).toEqual(['BUNDLE_OLDER_THAN_SOURCE']);
    expect(errors[0]?.severity).not.toBe('warning');
  });

  test('warns, does not fail, when an older CLI recorded no source hash', () => {
    const f = fixture({ bundle: 'export default 1;', source: 'export default 1;' });
    const errors = checkBundleIntegrity(f.dir, {
      integrity: { engineSha256: f.integrity.engineSha256 },
    });
    expect(errors.map((e) => e.code)).toEqual(['BUNDLE_SOURCE_UNRECORDED']);
    expect(errors[0]?.severity).toBe('warning');
  });

  test('is silent for an extension that ships no bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-integrity-'));
    expect(checkBundleIntegrity(dir, { integrity: { engineSha256: 'x' } })).toEqual([]);
  });
});
