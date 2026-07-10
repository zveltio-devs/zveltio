/**
 * Unit coverage for the registry catalog client (extension-download.ts).
 *
 * fetchRegistryCatalog() pulls the remote extension list, coerces each entry
 * (is_official 0/1→bool, publisher_tier allow-list, download_url default),
 * merges it over the built-in EXTENSION_CATALOG (remote wins per name, local
 * fills the rest), and caches a successful remote result for 5 min.
 *
 * Driven with a stubbed globalThis.fetch — no network. The module cache is
 * module-scoped with no reset seam, so the tests are ORDERED: the fallback
 * cases (which never populate the cache) run first, the success case (which
 * DOES cache) second-to-last, and the cache-hit assertion last.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EXTENSION_CATALOG } from '../../lib/extensions/extension-catalog.js';
import { fetchRegistryCatalog } from '../../lib/extensions/extension-download.js';

let originalFetch: typeof fetch;

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
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
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
    // The previous test populated the 5-min cache. A fetch that would throw
    // must NOT be reached — the cached catalog is returned.
    stubFetchThrows();
    const cat = await fetchRegistryCatalog();
    expect(cat.find((e) => e.name === 'remote-tool')).toBeDefined();
  });
});
