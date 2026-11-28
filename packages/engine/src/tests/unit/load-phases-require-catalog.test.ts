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
import {
  _setInlineForTests,
  enforcePublisherTier,
  INLINE_EXTENSIONS,
  runsAsWorker,
} from '../../lib/extensions/load-phases.js';

const saved = process.env.ZVELTIO_REQUIRE_CATALOG;

afterEach(() => {
  if (saved === undefined) delete process.env.ZVELTIO_REQUIRE_CATALOG;
  else process.env.ZVELTIO_REQUIRE_CATALOG = saved;
  extensionDownload._resetCatalogCacheForTests();
});

/**
 * The inline gate is reached only by a name on the engine's inline list (ADR
 * 0062 d1); every other extension runs as a worker.
 */
const INLINE = 'sms';
const MANIFEST = { name: INLINE, version: '1.0.0' } as never;

describe('enforcePublisherTier — ZVELTIO_REQUIRE_CATALOG', () => {
  it('blocks the extension when the registry is unreachable and the flag is set', async () => {
    process.env.ZVELTIO_REQUIRE_CATALOG = '1';
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND registry.zveltio.com'),
    );
    try {
      const r = await enforcePublisherTier(INLINE, MANIFEST, null, true);
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
      await enforcePublisherTier(INLINE, MANIFEST, null, true);
      expect(spy).toHaveBeenCalledWith({ requireRemote: true });
    } finally {
      spy.mockRestore();
    }
  });

  it('degrades to the local catalog when the flag is unset (listing stays offline-safe)', async () => {
    delete process.env.ZVELTIO_REQUIRE_CATALOG;
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([]);
    try {
      const r = await enforcePublisherTier(INLINE, MANIFEST, null, true);
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
    name: INLINE,
    version: '1.0.0',
    actions: [{ name: 'peek', reads: ['*'], writes: [] }],
  } as never;

  it('refuses "*" when no catalog proved the tier, though inline is let through', async () => {
    delete process.env.ZVELTIO_REQUIRE_CATALOG;
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockRejectedValue(
      new Error('registry down'),
    );
    try {
      expect((await enforcePublisherTier(INLINE, MANIFEST, null, true)).ok).toBe(true);
      const r = await enforcePublisherTier(INLINE, STAR, null, true);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toContain('no verified publisher tier');
    } finally {
      spy.mockRestore();
    }
  });

  // Every path that has not proven the tier first-party refuses "*".
  for (const [label, entries] of [
    ['a verified tier', [{ name: INLINE, publisher_tier: 'verified' }]],
    ['a community tier', [{ name: INLINE, publisher_tier: 'community' }]],
    ['an unofficial entry with no tier', [{ name: INLINE, is_official: false }]],
    ['no catalog entry', []],
  ] as const) {
    it(`refuses "*" for ${label}`, async () => {
      delete process.env.ZVELTIO_REQUIRE_CATALOG;
      const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue(
        entries as never,
      );
      try {
        expect((await enforcePublisherTier(INLINE, STAR, null, true)).ok).toBe(false);
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
      expect((await enforcePublisherTier(INLINE, STAR, null, true)).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('lets a catalog first-party extension list "*"', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      { name: INLINE, publisher_tier: 'first-party' } as never,
    ]);
    try {
      const r = await enforcePublisherTier(INLINE, STAR, null, true);
      expect(r.ok && r.value.firstParty).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('enforcePublisherTier — "*" on the runner (ADR 0062 d2)', () => {
  const WORKER = 'sideloaded-ext';
  /** No `engine.isolation`: the manifest does not decide where it runs (d1). */
  const STAR = {
    name: WORKER,
    version: '1.0.0',
    engine: { entry: 'engine/index.js', bundled: true },
    actions: [{ name: 'peek', reads: ['*'], writes: [] }],
  } as never;
  const catalog = (entries: unknown[]) =>
    spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue(entries as never);

  it('level 0: a registry signature whose catalogue tier is first-party may list "*"', async () => {
    const spy = catalog([{ name: WORKER, publisher_tier: 'first-party' }]);
    try {
      const r = await enforcePublisherTier(WORKER, STAR, null, true);
      expect(r.ok && r.value.firstParty).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  for (const [label, entries] of [
    ['a verified tier (level 2)', [{ name: WORKER, publisher_tier: 'verified' }]],
    ['a community tier (level 2)', [{ name: WORKER, publisher_tier: 'community' }]],
    ['no catalog entry (level 2)', []],
  ] as const) {
    it(`refuses "*" on the runner for ${label}, test override or not`, async () => {
      const spy = catalog(entries as never);
      try {
        for (const inline of [false, true]) {
          const was = _setInlineForTests(inline);
          try {
            const worker = inline
              ? ({
                  ...(STAR as object),
                  engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
                } as never)
              : STAR;
            const r = await enforcePublisherTier(WORKER, worker, null, true);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.lastLoadError).toContain('no verified first-party tier');
          } finally {
            _setInlineForTests(was);
          }
        }
      } finally {
        spy.mockRestore();
      }
    });
  }

  it('refuses "*" on the runner when no catalog loaded', async () => {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockRejectedValue(
      new Error('registry down'),
    );
    try {
      expect((await enforcePublisherTier(WORKER, STAR, null, true)).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('level 3: an operator key is never first-party, whatever the catalogue says of the name', async () => {
    const spy = catalog([{ name: WORKER, publisher_tier: 'first-party' }]);
    try {
      const r = await enforcePublisherTier(WORKER, STAR, 'my-key', false);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.lastLoadError).toMatch(/operator key "my-key" \(level 3\).*"\*"/);
      // A listed name changes nothing: an operator key runs on the runner.
      const listed = { ...(STAR as object), name: INLINE } as never;
      const r2 = await enforcePublisherTier(INLINE, listed, 'my-key', false);
      expect(r2.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('an unsigned directory is refused on the runner before any tier', async () => {
    const r = await enforcePublisherTier(WORKER, STAR, null, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('is not signed');
  });

  it('a worker must be bundled', async () => {
    const loose = { name: WORKER, version: '1.0.0' } as never;
    const r = await enforcePublisherTier(WORKER, loose, null, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastLoadError).toContain('engine.bundled');
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
});

describe('runsAsWorker — the engine decides, never the manifest (ADR 0062 d1)', () => {
  const declares = (isolation?: string) =>
    ({ name: 'x', version: '1.0.0', engine: { entry: 'e.js', bundled: true, isolation } }) as never;

  it('runs every extension off the inline list as a worker, whatever engine.isolation says', () => {
    for (const isolation of [undefined, 'inline', 'worker']) {
      expect(runsAsWorker('finance/invoicing', declares(isolation), null)).toBe(true);
    }
    expect(runsAsWorker('finance/invoicing', null, null)).toBe(true);
  });

  it('runs a listed extension inline, whatever engine.isolation says', () => {
    for (const isolation of [undefined, 'inline', 'worker']) {
      expect(runsAsWorker('billing', declares(isolation), null)).toBe(false);
    }
  });

  it('runs an operator-signed extension on the runner, listed or not (level 3)', () => {
    expect(runsAsWorker('billing', declares(), 'my-key')).toBe(true);
  });

  it('the inline list is the ADR 0062 porting list and only shrinks', () => {
    // An entry leaves when its extension is ported; none is ever added (d4).
    const PORTING_LIST = [
      'analytics/dashboard',
      'auth/ldap',
      'auth/saml',
      'billing',
      'compliance/gdpr',
      'content/document-templates',
      'content/documents',
      'content/pages',
      'data/export',
      'developer/api-docs',
      'developer/byod',
      'integrations/api-connector',
      'operations/traceability',
      'sms',
    ];
    for (const name of INLINE_EXTENSIONS) expect(PORTING_LIST).toContain(name);
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
