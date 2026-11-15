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
 * inherit first-party tier and be allowed to run INLINE (marketplace-policy.md §2).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as extensionDownload from '../../lib/extensions/extension-download.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import { _setInlineForTests, enforcePublisherTier } from '../../lib/extensions/load-phases.js';

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

describe('enforcePublisherTier — "*" in an action (ADR 0053 d5)', () => {
  const STAR = {
    name: 'sideloaded-ext',
    version: '1.0.0',
    actions: [{ name: 'peek', reads: ['*'], writes: [] }],
  } as never;

  it('refuses "*" when no catalog proved the tier, though inline is let through', async () => {
    delete process.env.ZVELTIO_REQUIRE_CATALOG;
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockRejectedValue(
      new Error('registry down'),
    );
    try {
      expect((await enforcePublisherTier('sideloaded-ext', MANIFEST)).ok).toBe(true);
      const r = await enforcePublisherTier('sideloaded-ext', STAR);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('no verified publisher tier');
    } finally {
      spy.mockRestore();
    }
  });

  // Every path that has not proven the tier first-party refuses "*".
  for (const [label, entries] of [
    ['a verified tier', [{ name: 'sideloaded-ext', publisher_tier: 'verified' }]],
    ['a community tier', [{ name: 'sideloaded-ext', publisher_tier: 'community' }]],
    ['an unofficial entry with no tier', [{ name: 'sideloaded-ext', is_official: false }]],
    ['no catalog entry', []],
  ] as const) {
    it(`refuses "*" for ${label}`, async () => {
      delete process.env.ZVELTIO_REQUIRE_CATALOG;
      const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue(
        entries as never,
      );
      try {
        expect((await enforcePublisherTier('sideloaded-ext', STAR)).ok).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  }

  it('refuses "*" when the catalog fetch fails under ZVELTIO_REQUIRE_CATALOG', async () => {
    process.env.ZVELTIO_REQUIRE_CATALOG = '1';
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockRejectedValue(
      new Error('registry down'),
    );
    try {
      expect((await enforcePublisherTier('sideloaded-ext', STAR)).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses "*" from a worker extension, first-party in the catalog or not, test override or not', async () => {
    const worker = {
      ...(STAR as object),
      engine: { entry: 'engine/index.js', isolation: 'worker', bundled: true },
    } as never;
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      { name: 'sideloaded-ext', publisher_tier: 'first-party' } as never,
    ]);
    try {
      for (const inline of [false, true]) {
        const was = _setInlineForTests(inline);
        try {
          const r = await enforcePublisherTier('sideloaded-ext', worker);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.lastLoadError).toContain('runs in worker isolation');
        } finally {
          _setInlineForTests(was);
        }
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('the test inline override has no caller outside the tests', () => {
    const root = join(import.meta.dir, '..', '..');
    const callers = [...new Glob('**/*.ts').scanSync(root)].filter(
      (f) =>
        !f.startsWith('tests/') &&
        /(?<!function )_setInlineForTests\(/.test(readFileSync(join(root, f), 'utf8')),
    );
    expect(callers).toEqual([]);
  });

  it('lets a catalog first-party extension list "*"', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      { name: 'sideloaded-ext', publisher_tier: 'first-party' } as never,
    ]);
    try {
      expect((await enforcePublisherTier('sideloaded-ext', STAR)).ok).toBe(true);
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
