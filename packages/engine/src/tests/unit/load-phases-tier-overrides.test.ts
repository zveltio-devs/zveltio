/**
 * enforcePublisherTier (load-phases.ts) — the branches the existing suites don't
 * reach. `load-phases-peer-quota.test.ts` covers only the "absent from catalog →
 * community → inline blocked" path; these cover the two operator/manifest
 * escape hatches and the tiers that ARE allowed to run inline.
 *
 * MARKETPLACE-POLICY.md §2: first-party/verified may run inline; community (or
 * unknown) must declare engine.isolation: "worker".
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { enforcePublisherTier } from '../../lib/extensions/load-phases.js';
import * as extensionDownload from '../../lib/extensions/extension-download.js';
import type { ExtensionCatalogEntry } from '../../lib/extensions/extension-catalog.js';

const savedAllowInline = process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;

function catalogEntry(over: Partial<ExtensionCatalogEntry>): ExtensionCatalogEntry {
  return {
    name: 'the-ext',
    displayName: 'The Ext',
    description: 'x',
    category: 'custom',
    version: '1.0.0',
    author: 'x',
    tags: [],
    permissions: [],
    ...over,
  } as ExtensionCatalogEntry;
}

afterEach(() => {
  if (savedAllowInline === undefined) delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
  else process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = savedAllowInline;
});

describe('enforcePublisherTier — escape hatches', () => {
  it('ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1 skips the gate entirely (no catalog fetch)', async () => {
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog');
    try {
      const r = await enforcePublisherTier('sideloaded-ext', {
        name: 'sideloaded-ext',
        version: '1.0.0',
      } as never);
      expect(r.ok).toBe(true);
      // the override short-circuits before any registry call
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a manifest declaring engine.isolation "worker" is allowed without a catalog', async () => {
    delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog');
    try {
      const r = await enforcePublisherTier('worker-ext', {
        name: 'worker-ext',
        version: '1.0.0',
        engine: { isolation: 'worker' },
      } as never);
      expect(r.ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('enforcePublisherTier — tiers allowed inline', () => {
  afterEach(() => {
    delete process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY;
  });

  it('a first-party catalog entry may run inline', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      catalogEntry({ name: 'fp-ext', publisher_tier: 'first-party' }),
    ]);
    try {
      const r = await enforcePublisherTier('fp-ext', { name: 'fp-ext', version: '1.0.0' } as never);
      expect(r.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a verified catalog entry may run inline', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      catalogEntry({ name: 'v-ext', publisher_tier: 'verified' }),
    ]);
    try {
      const r = await enforcePublisherTier('v-ext', { name: 'v-ext', version: '1.0.0' } as never);
      expect(r.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('an is_official entry with no publisher_tier falls back to first-party (inline ok)', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      catalogEntry({ name: 'legacy-ext', is_official: true }),
    ]);
    try {
      const r = await enforcePublisherTier('legacy-ext', {
        name: 'legacy-ext',
        version: '1.0.0',
      } as never);
      expect(r.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a community catalog entry is blocked inline', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      catalogEntry({ name: 'c-ext', publisher_tier: 'community' }),
    ]);
    try {
      const r = await enforcePublisherTier('c-ext', { name: 'c-ext', version: '1.0.0' } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('community');
    } finally {
      spy.mockRestore();
    }
  });
});
