/**
 * npm-install.ts — unsafe semver range rejection.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installExtensionNpmDependencies } from '../../lib/extensions/npm-install.js';

let extBase: string;
let savedExtensionsDir: string | undefined;

beforeEach(() => {
  extBase = mkdtempSync(join(tmpdir(), 'zveltio-npm-ver-'));
  savedExtensionsDir = process.env.EXTENSIONS_DIR;
  process.env.EXTENSIONS_DIR = extBase;
});

afterEach(() => {
  if (savedExtensionsDir === undefined) delete process.env.EXTENSIONS_DIR;
  else process.env.EXTENSIONS_DIR = savedExtensionsDir;
});

describe('installExtensionNpmDependencies — version validation', () => {
  it('rejects unsafe version ranges before spawning', async () => {
    await expect(
      installExtensionNpmDependencies('evil', { nanoid: 'file:../../etc/passwd' }),
    ).rejects.toThrow(/unsafe peerDependency/i);
  });

  it('rejects packages not on the platform allow-list', async () => {
    await expect(
      installExtensionNpmDependencies('evil', { 'totally-unknown-pkg': '1.0.0' }),
    ).rejects.toThrow(/disallowed peerDependency/i);
  });
});
