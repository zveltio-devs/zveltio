import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resignSteps } from './extension-dev.js';

describe('extension dev: a signed directory is packed and signed again before reload', () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-ext-dev-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('unsigned directory: nothing to redo', () => {
    withDir((dir) => expect(resignSteps(dir)).toBeNull());
  });

  test('signed directory: pack, then sign with the key that signed it', () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, 'signature.json'),
        JSON.stringify({ keyId: 'op-1', tier: 'private' }),
      );
      expect(resignSteps(dir)).toEqual([
        ['extension', 'pack', '--dir', dir],
        ['extension', 'sign', '--dir', dir, '--key-id', 'op-1'],
      ]);
    });
  });

  test('signature.json without a keyId is refused, not signed with a default key', () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'signature.json'), '{}');
      expect(() => resignSteps(dir)).toThrow(/names no keyId/);
    });
  });
});
