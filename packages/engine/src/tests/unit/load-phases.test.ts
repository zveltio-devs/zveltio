/**
 * Extension load phases (lib/extensions/load-phases.ts) — the pure validation
 * pipeline the loader replays. Covers the deterministic fs paths (manifest
 * parse/validate/compat, publisher-tier fast-paths, entry-path resolution);
 * the DB-dependency + catalog-fetch branches are covered by the marketplace +
 * third-party-isolation suites.
 */

import { describe, it, expect, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enforcePublisherTier,
  resolveEntryPath,
  resolveManifest,
} from '../../lib/extensions/load-phases.js';
import * as extensionDownload from '../../lib/extensions/extension-download.js';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';
// biome-ignore lint/suspicious/noExplicitAny: manifest/db fixtures in tests
type Any = any;

const db = {} as Database; // never queried on the minimal-manifest paths

/** Make a throwaway extension dir with the given files (path → contents). */
function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-ext-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('resolveManifest', () => {
  it('no manifest.json → ok with defaults (manifest null, js, custom)', async () => {
    const r = await resolveManifest('ext', tmpExt({}), db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifest).toBeNull();
      expect(r.value.extRuntime).toBe('js');
      expect(r.value.extCategory).toBe('custom');
    }
  });

  it('malformed manifest.json → PhaseFail (warn)', async () => {
    const r = await resolveManifest('ext', tmpExt({ 'manifest.json': '{not json' }), db);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.logLevel).toBe('warn');
      expect(r.lastLoadError).toContain('invalid manifest.json');
    }
  });

  it('schema-invalid manifest (empty name) → PhaseFail', async () => {
    const r = await resolveManifest(
      'ext',
      tmpExt({ 'manifest.json': '{"name":"","version":"1.0.0"}' }),
      db,
    );
    expect(r.ok).toBe(false);
  });

  it('valid minimal manifest → ok, category/runtime reflected', async () => {
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        category: 'analytics',
        runtime: 'wasm',
      }),
    });
    const r = await resolveManifest('probe', dir, db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifest?.name).toBe('probe');
      expect(r.value.extCategory).toBe('analytics');
      expect(r.value.extRuntime).toBe('wasm');
    }
  });

  it('engine-incompatible manifest → PhaseFail', async () => {
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        zveltioMinVersion: '999.0.0',
      }),
    });
    const r = await resolveManifest('probe', dir, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.logArgs.join(' ')).toContain('incompatible');
  });

  it('bundle size quota exceeded → PhaseFail', async () => {
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        quotas: { bundleSizeKbMax: 1, migrationsMax: 100, nodeModulesSizeMbMax: 200 },
      }),
      'big.bin': 'x'.repeat(4096),
    });
    const r = await resolveManifest('probe', dir, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('bundleSizeKb');
  });

  it('missing extension dependency → PhaseFail', async () => {
    const canned = new CannedDb();
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        dependencies: [{ name: 'needs-other-ext' }],
      }),
    });
    const r = await resolveManifest('probe', dir, canned.kysely as unknown as Database);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('Missing required extensions');
  });

  it('missing postgres extension → PhaseFail', async () => {
    const canned = new CannedDb();
    canned.when(/pg_extension/, []);
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        requires: { postgres_extensions: ['postgis'] },
      }),
    });
    const r = await resolveManifest('probe', dir, canned.kysely as unknown as Database);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('postgis');
  });

  it('continues when pg_extension lookup throws (non-fatal)', async () => {
    const canned = new CannedDb();
    canned.fail(/pg_extension/, new Error('permission denied'));
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        requires: { postgres_extensions: ['postgis'] },
      }),
    });
    const r = await resolveManifest('probe', dir, canned.kysely as unknown as Database);
    expect(r.ok).toBe(true);
  });

  it('passes when declared extension dependencies are satisfied', async () => {
    const canned = new CannedDb();
    canned.when(/zv_extension_registry/i, [{ version: '2.0.0', is_enabled: true }]);
    const dir = tmpExt({
      'manifest.json': JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        dependencies: [{ name: 'dep-ext' }],
      }),
    });
    const r = await resolveManifest('dep-ext', dir, canned.kysely as unknown as Database);
    expect(r.ok).toBe(true);
  });
});

describe('enforcePublisherTier — fast paths', () => {
  it('worker isolation → ok (no catalog fetch)', async () => {
    const r = await enforcePublisherTier('ext', { engine: { isolation: 'worker' } } as Any);
    expect(r.ok).toBe(true);
  });

  it('ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1 → ok', async () => {
    const prev = process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    try {
      const r = await enforcePublisherTier('ext', null);
      expect(r.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
      else process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = prev;
    }
  });

  it('community catalog entry without worker isolation → PhaseFail', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      {
        name: 'community-ext',
        displayName: 'Community',
        description: 'x',
        category: 'custom',
        version: '1.0.0',
        author: 'x',
        tags: [],
        permissions: [],
        publisher_tier: 'community',
      },
    ]);
    try {
      const r = await enforcePublisherTier('community-ext', {
        name: 'community-ext',
        version: '1.0.0',
      } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('worker isolation');
    } finally {
      spy.mockRestore();
    }
  });

  it('ZVELTIO_REQUIRE_CATALOG=1 with catalog fetch failure → PhaseFail', async () => {
    const prevRequire = process.env.ZVELTIO_REQUIRE_CATALOG;
    process.env.ZVELTIO_REQUIRE_CATALOG = '1';
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockRejectedValue(
      new Error('offline'),
    );
    try {
      const r = await enforcePublisherTier('ext', { name: 'ext', version: '1.0.0' } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('ZVELTIO_REQUIRE_CATALOG');
    } finally {
      spy.mockRestore();
      if (prevRequire === undefined) delete process.env.ZVELTIO_REQUIRE_CATALOG;
      else process.env.ZVELTIO_REQUIRE_CATALOG = prevRequire;
    }
  });

  it('verified publisher tier in catalog → inline allowed', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      {
        name: 'verified-ext',
        displayName: 'Verified',
        description: 'x',
        category: 'custom',
        version: '1.0.0',
        author: 'x',
        tags: [],
        permissions: [],
        publisher_tier: 'verified',
        is_official: false,
      },
    ]);
    try {
      const r = await enforcePublisherTier('verified-ext', {
        name: 'verified-ext',
        version: '1.0.0',
      } as never);
      expect(r.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('is_official first-party catalog entry → inline allowed', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      {
        name: 'finance/invoicing',
        displayName: 'Invoicing',
        description: 'x',
        category: 'finance',
        version: '1.0.0',
        author: 'zveltio',
        tags: [],
        permissions: [],
        is_official: true,
      },
    ]);
    try {
      const r = await enforcePublisherTier('finance/invoicing', {
        name: 'finance/invoicing',
        version: '1.0.0',
      } as never);
      expect(r.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resolveEntryPath', () => {
  const bundled = (extra: Record<string, unknown> = {}): Any => ({
    name: 'probe',
    version: '1.0.0',
    engine: { bundled: true, entry: 'engine/index.js', ...extra },
  });

  it('bundled entry present → ok, returns the resolved path', async () => {
    const dir = tmpExt({ 'engine/index.js': 'export function register(){}' });
    const r = await resolveEntryPath('probe', dir, join(dir, 'engine/index.js'), bundled());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(join(dir, 'engine/index.js'));
  });

  it('bundled entry missing → PhaseFail (error)', async () => {
    const dir = tmpExt({ 'manifest.json': '{}' });
    const r = await resolveEntryPath('probe', dir, join(dir, 'engine/index.js'), bundled());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.logLevel).toBe('error');
      expect(r.lastLoadError).toContain('not on disk');
    }
  });

  it('bundled integrity mismatch → PhaseFail', async () => {
    const dir = tmpExt({ 'engine/index.js': 'real bytes' });
    const manifest = bundled();
    manifest.integrity = { engineSha256: 'a'.repeat(64) }; // wrong hash
    const r = await resolveEntryPath('probe', dir, join(dir, 'engine/index.js'), manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('integrity check failed');
  });

  it('bundled with peerDependencies but no bundlePeers → PhaseFail', async () => {
    const dir = tmpExt({ 'engine/index.js': 'x' });
    const manifest = bundled();
    manifest.peerDependencies = { imapflow: '^1.0.0' };
    const r = await resolveEntryPath('probe', dir, join(dir, 'engine/index.js'), manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('bundlePeers');
  });

  it('non-bundled extension refused in production without dev-reload flag', async () => {
    const prevNode = process.env.NODE_ENV;
    const prevReload = process.env.ZVELTIO_EXTENSION_DEV_RELOAD;
    process.env.NODE_ENV = 'production';
    delete process.env.ZVELTIO_EXTENSION_DEV_RELOAD;
    const dir = tmpExt({ 'engine/index.js': 'export default {}' });
    try {
      const r = await resolveEntryPath('probe', dir, join(dir, 'engine/index.js'), {
        name: 'probe',
        version: '1.0.0',
      } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('not bundled');
    } finally {
      if (prevNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNode;
      if (prevReload === undefined) delete process.env.ZVELTIO_EXTENSION_DEV_RELOAD;
      else process.env.ZVELTIO_EXTENSION_DEV_RELOAD = prevReload;
    }
  });
});
