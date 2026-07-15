/**
 * Unit coverage for the registry catalog client (extension-download.ts).
 *
 * fetchRegistryCatalog() pulls the remote extension list, coerces each entry
 * (is_official 0/1→bool, publisher_tier allow-list, download_url default),
 * merges it over the built-in EXTENSION_CATALOG (remote wins per name, local
 * fills the rest), and caches a successful remote result for 5 min.
 *
 * Driven with a stubbed globalThis.fetch — no network. The catalog cache is a
 * module-global singleton SHARED across every test file that imports this
 * module, so each test resets it (`_resetCatalogCacheForTests`) to stay
 * independent of cross-file execution order (the previous "tests are ORDERED"
 * contract flaked when another file populated the cache first).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EXTENSION_CATALOG } from '../../lib/extensions/extension-catalog.js';
import {
  fetchRegistryCatalog,
  _resetCatalogCacheForTests,
} from '../../lib/extensions/extension-download.js';

// Capture the real fetch at load time (before any stub), so afterEach restores
// it rather than perpetuating a stub another file may have left behind.
const originalFetch: typeof fetch = globalThis.fetch;

function stubFetchOk(extensions: unknown[]): void {
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ extensions }),
      text: async () => JSON.stringify({ extensions }),
    }) as Response) as unknown as typeof fetch;
}

function stubFetchStatus(status: number): void {
  globalThis.fetch = (async () =>
    ({
      ok: status < 400,
      status,
      json: async () => ({}),
      text: async () => '',
    }) as Response) as unknown as typeof fetch;
}

function stubFetchThrows(): void {
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  _resetCatalogCacheForTests(); // start every test with an empty cache
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetCatalogCacheForTests(); // don't leak a populated cache to other files
});

describe('fetchRegistryCatalog', () => {
  it('falls back to the local catalog when the registry fetch throws', async () => {
    stubFetchThrows();
    const cat = await fetchRegistryCatalog();
    expect(cat.length).toBeGreaterThan(0);
    // local entries default to is_official=true
    expect(cat.every((e) => typeof e.is_official === 'boolean')).toBe(true);
    // every built-in catalog name is present
    const names = new Set(cat.map((e) => e.name));
    for (const local of EXTENSION_CATALOG) expect(names.has(local.name)).toBe(true);
  });

  it('falls back to the local catalog on a non-ok registry response', async () => {
    stubFetchStatus(503);
    const cat = await fetchRegistryCatalog();
    expect(cat.length).toBe(EXTENSION_CATALOG.length);
  });

  it('returns the local catalog when the registry lists zero extensions', async () => {
    stubFetchOk([]);
    const cat = await fetchRegistryCatalog();
    // empty remote → cache NOT populated, local catalog returned
    expect(cat.length).toBe(EXTENSION_CATALOG.length);
  });

  it('maps and merges remote entries, coercing is_official and publisher_tier', async () => {
    const localName = EXTENSION_CATALOG[0]!.name;
    stubFetchOk([
      {
        name: 'remote-tool',
        display_name: 'Remote Tool',
        category: 'crm',
        version: '2.1.0',
        developer_username: 'acme',
        is_official: 1, // integer form (D1/SQLite) → must coerce to true
        publisher_tier: 'verified',
      },
      {
        // overrides a built-in entry by name; remote wins
        name: localName,
        is_official: true,
        publisher_tier: 'garbage', // invalid → dropped to undefined
      },
    ]);

    const cat = await fetchRegistryCatalog();
    const remote = cat.find((e) => e.name === 'remote-tool');
    expect(remote).toBeDefined();
    expect(remote?.is_official).toBe(true); // 1 coerced
    expect(remote?.displayName).toBe('Remote Tool');
    expect(remote?.author).toBe('acme');
    expect(remote?.publisher_tier).toBe('verified');
    // default download_url derived from REGISTRY_URL + encoded name
    expect(remote?.download_url).toContain('/api/extensions/by-name/remote-tool/download');

    // remote-wins merge: the overriding entry appears once, with tier coerced away
    const overridden = cat.filter((e) => e.name === localName);
    expect(overridden.length).toBe(1);
    expect(overridden[0]?.publisher_tier).toBeUndefined();
  });

  it('serves the cached result without re-fetching after a successful load', async () => {
    // Self-contained: populate the cache with a successful load first…
    stubFetchOk([
      {
        name: 'remote-tool',
        display_name: 'Remote Tool',
        category: 'crm',
        version: '2.1.0',
        developer_username: 'acme',
        is_official: 1,
        publisher_tier: 'verified',
      },
    ]);
    await fetchRegistryCatalog();
    // …then a fetch that would throw must NOT be reached — the cache is served.
    stubFetchThrows();
    const cat = await fetchRegistryCatalog();
    expect(cat.find((e) => e.name === 'remote-tool')).toBeDefined();
  });
});
