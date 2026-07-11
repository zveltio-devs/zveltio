/**
 * resolveManifest node_modules workspace quota (lib/extensions/load-phases.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../../lib/extensions/load-phases.js';
import * as extensionUtils from '../../lib/extensions/extension-utils.js';
import * as npmInstall from '../../lib/extensions/npm-install.js';
import type { Database } from '../../db/index.js';

const db = {} as Database;

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-nm-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

let savedExtDir: string | undefined;

afterEach(() => {
  if (savedExtDir === undefined) delete process.env.EXTENSIONS_DIR;
  else process.env.EXTENSIONS_DIR = savedExtDir;
});

describe('resolveManifest — nodeModulesSizeMb quota', () => {
  it('fails when peer install succeeds but workspace node_modules exceeds quota', async () => {
    savedExtDir = process.env.EXTENSIONS_DIR;
    process.env.EXTENSIONS_DIR = mkdtempSync(join(tmpdir(), 'zv-extbase-nm-'));

    const installSpy = spyOn(npmInstall, 'installExtensionNpmDependencies').mockResolvedValue(
      undefined,
    );
    const sizeSpy = spyOn(extensionUtils, 'directorySizeBytes').mockImplementation(async (p) => {
      if (String(p).includes('node_modules')) return 250 * 1024 * 1024;
      return 512;
    });
    try {
      const dir = tmpExt({
        'manifest.json': JSON.stringify({
          name: 'probe',
          version: '1.0.0',
          peerDependencies: { imapflow: '^1.0.0' },
          quotas: { bundleSizeKbMax: 50_000, migrationsMax: 100, nodeModulesSizeMbMax: 200 },
        }),
      });
      const r = await resolveManifest('probe', dir, db);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('nodeModulesSizeMb');
    } finally {
      installSpy.mockRestore();
      sizeSpy.mockRestore();
    }
  });
});
