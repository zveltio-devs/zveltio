/**
 * ZVELTIO_REQUIRE_CATALOG=1 fail-closed enforcement (load-phases.ts).
 *
 * Regression guard: this branch was DEAD. `fetchRegistryCatalog()` caught every
 * error of its own and always returned the local catalog, so `catalogFetchFailed`
 * could never become true and the operator's fail-closed switch silently did
 * nothing. The fix gives the fetch a `requireRemote` option that rethrows.
 *
 * Why it matters: local catalog entries are stamped `is_official: true`, so with
 * the registry unreachable a sideloaded extension named after one of them would
 * inherit first-party tier and be allowed to run INLINE (MARKETPLACE-POLICY.md §2).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as extensionDownload from '../../lib/extensions/extension-download.js';
import { enforcePublisherTier } from '../../lib/extensions/load-phases.js';

const saved = process.env.ZVELTIO_REQUIRE_CATALOG;

afterEach(() => {
  if (saved === undefined) delete process.env.ZVELTIO_REQUIRE_CATALOG;
  else process.env.ZVELTIO_REQUIRE_CATALOG = saved;
  extensionDownload._resetCatalogCacheForTests();
});

const MANIFEST = { name: 'sideloaded-ext', version: '1.0.0' } as never;

describe('enforcePublisherTier — ZVELTIO_REQUIRE_CATALOG', () => {
  it('blocks the extension when the registry is unreachable and the flag is set', async () => {
    process.env.ZVELTIO_REQUIRE_CATALOG = '1';
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND registry.zveltio.com'),
    );
    try {
      const r = await enforcePublisherTier('sideloaded-ext', MANIFEST);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('ZVELTIO_REQUIRE_CATALOG');
    } finally {
      spy.mockRestore();
    }
  });

  it('asks the catalog to fail closed only when the flag is set', async () => {
    process.env.ZVELTIO_REQUIRE_CATALOG = '1';
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([]);
    try {
      await enforcePublisherTier('sideloaded-ext', MANIFEST);
      expect(spy).toHaveBeenCalledWith({ requireRemote: true });
    } finally {
      spy.mockRestore();
    }
  });

  it('degrades to the local catalog when the flag is unset (listing stays offline-safe)', async () => {
    delete process.env.ZVELTIO_REQUIRE_CATALOG;
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([]);
    try {
      const r = await enforcePublisherTier('sideloaded-ext', MANIFEST);
      expect(spy).toHaveBeenCalledWith({ requireRemote: false });
      // absent from the catalog → community → still blocked inline, but by the
      // tier rule rather than the fail-closed switch
      expect(r.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('fetchRegistryCatalog — requireRemote', () => {
  it('swallows a registry failure by default and returns the local catalog', async () => {
    extensionDownload._resetCatalogCacheForTests();
    const spy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    try {
      const catalog = await extensionDownload.fetchRegistryCatalog();
      expect(catalog.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('rethrows the registry failure when requireRemote is set', async () => {
    extensionDownload._resetCatalogCacheForTests();
    const spy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    try {
      await expect(extensionDownload.fetchRegistryCatalog({ requireRemote: true })).rejects.toThrow(
        'network down',
      );
    } finally {
      spy.mockRestore();
    }
  });
});
