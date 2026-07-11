/**
 * resolveManifest quotas + peerDependencies branches (lib/extensions/load-phases.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest, enforcePublisherTier } from '../../lib/extensions/load-phases.js';
import * as npmInstall from '../../lib/extensions/npm-install.js';
import * as extensionDownload from '../../lib/extensions/extension-download.js';
import type { Database } from '../../db/index.js';

const db = {} as Database;

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-ext-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('resolveManifest — quotas', () => {
  it('returns the manifest migrationsMax as migrationsLimit', async () => {
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        quotas: { bundleSizeKbMax: 50_000, migrationsMax: 12, nodeModulesSizeMbMax: 200 },
      }),
    });
    const r = await resolveManifest('probe', dir, db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.migrationsLimit).toBe(12);
  });
});

describe('resolveManifest — peerDependencies', () => {
  it('fails when npm peer install throws', async () => {
    const spy = spyOn(npmInstall, 'installExtensionNpmDependencies').mockRejectedValue(
      new Error('bun install failed'),
    );
    try {
      const dir = tmpExt({
        'manifest.json': JSON.stringify({
          name: 'probe',
          version: '1.0.0',
          peerDependencies: { imapflow: '^1.0.0' },
        }),
      });
      const r = await resolveManifest('probe', dir, db);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('bun install failed');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('enforcePublisherTier — absent catalog entry', () => {
  it('treats an extension missing from the catalog as community (inline blocked)', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      {
        name: 'other-ext',
        displayName: 'Other',
        description: 'x',
        category: 'custom',
        version: '1.0.0',
        author: 'x',
        tags: [],
        permissions: [],
        publisher_tier: 'verified',
      },
    ]);
    try {
      const r = await enforcePublisherTier('sideloaded-ext', {
        name: 'sideloaded-ext',
        version: '1.0.0',
      } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('not in the marketplace catalog');
    } finally {
      spy.mockRestore();
    }
  });
});
