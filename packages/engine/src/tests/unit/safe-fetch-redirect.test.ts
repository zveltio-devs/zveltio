/**
 * safe-fetch.ts — redirect re-validation and hop limits.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { safeFetch } from '../../lib/edge-functions/safe-fetch.js';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('safeFetch — redirects', () => {
  it('follows a redirect after re-validating the Location URL', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/start')) {
        return {
          status: 302,
          headers: new Headers({ location: 'https://example.com/final' }),
        } as Response;
      }
      return { status: 200, ok: true, text: async () => 'ok' } as Response;
    }) as unknown as typeof fetch;

    const res = await safeFetch('https://example.com/start');
    expect(res.status).toBe(200);
  });

  it('rejects redirects with no Location header', async () => {
    globalThis.fetch = (async () =>
      ({
        status: 301,
        headers: new Headers(),
      }) as Response) as unknown as typeof fetch;

    await expect(safeFetch('https://example.com/redirect')).rejects.toThrow(/no Location header/);
  });

  it('rejects redirect chains longer than five hops', async () => {
    let hops = 0;
    globalThis.fetch = (async () => {
      hops++;
      return {
        status: 302,
        headers: new Headers({ location: 'https://example.com/loop' }),
      } as Response;
    }) as unknown as typeof fetch;

    await expect(safeFetch('https://example.com/loop')).rejects.toThrow(/Too many redirects/);
    expect(hops).toBeGreaterThan(5);
  });
});
