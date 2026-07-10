/**
 * Extension peerDependency installer (lib/extensions/npm-install.ts).
 *
 * Uses a temp EXTENSIONS_DIR — no real bun/npm spawn in the happy-path
 * early-return case; validation failures are pure.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installExtensionNpmDependencies } from '../../lib/extensions/npm-install.js';

let extBase: string;
let savedExtensionsDir: string | undefined;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-npm-install-'));
  savedExtensionsDir = process.env.EXTENSIONS_DIR;
  process.env.EXTENSIONS_DIR = extBase;
});

afterEach(() => {
  if (savedExtensionsDir === undefined) delete process.env.EXTENSIONS_DIR;
  else process.env.EXTENSIONS_DIR = savedExtensionsDir;
});

describe('installExtensionNpmDependencies', () => {
  it('returns immediately when every peer is already on disk', async () => {
    mkdirSync(join(extBase, 'node_modules', 'hono'), { recursive: true });
    writeFileSync(join(extBase, 'node_modules', 'hono', 'package.json'), '{}');
    await expect(
      installExtensionNpmDependencies('probe', { hono: '^4.0.0' }),
    ).resolves.toBeUndefined();
  });

  it('rejects unsafe package names before spawning', async () => {
    await expect(
      installExtensionNpmDependencies('evil', { 'foo;rm -rf': '^1.0.0' }),
    ).rejects.toThrow(/unsafe peerDependency/i);
  });

  it('rejects packages outside the platform allow-list', async () => {
    await expect(
      installExtensionNpmDependencies('evil', { 'not-on-allowlist-xyz': '^1.0.0' }),
    ).rejects.toThrow(/allow-list/i);
  });
});
