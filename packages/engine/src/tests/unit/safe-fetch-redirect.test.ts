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
    // The first request plus five hops; the sixth hop is refused before it is sent.
    expect(hops).toBe(6);
  });
});

type Call = { url: string; init: RequestInit };

/** Answers each request with the next response in `script`, recording what was sent. */
function scripted(...script: Partial<Response>[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return (script[calls.length - 1] ?? { status: 200, headers: new Headers() }) as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const to = (location: string, status = 302): Partial<Response> => ({
  status,
  headers: new Headers({ location }),
});

describe('safeFetch — what a redirect hop may reach and carry', () => {
  it('refuses a private target before sending anything', async () => {
    const calls = scripted();
    await expect(safeFetch('http://127.0.0.1/admin')).rejects.toThrow(/blocked/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a redirect to cloud metadata without requesting it', async () => {
    const calls = scripted(to('http://169.254.169.254/latest/meta-data/'));
    await expect(safeFetch('https://example.com/start')).rejects.toThrow(/blocked/);
    expect(calls).toHaveLength(1);
  });

  it('resolves a relative Location against the URL that answered', async () => {
    const calls = scripted(to('../next?x=1'));
    await safeFetch('https://example.com/a/b/start');
    expect(new URL(calls[1].url).pathname + new URL(calls[1].url).search).toBe('/a/next?x=1');
  });

  it('drops credentials on a hop to another origin', async () => {
    const calls = scripted(to('https://example.org/elsewhere'));
    await safeFetch('https://example.com/start', {
      headers: { authorization: 'Bearer s3cret', cookie: 'sid=1', 'x-zveltio-signature': 'sig' },
    });
    const sent = new Headers(calls[1].init.headers);
    expect(sent.get('authorization')).toBeNull();
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('x-zveltio-signature')).toBe('sig');
  });

  it('keeps credentials on a hop within the same origin', async () => {
    const calls = scripted(to('/moved'));
    await safeFetch('https://example.com/start', { headers: { authorization: 'Bearer s3cret' } });
    expect(new Headers(calls[1].init.headers).get('authorization')).toBe('Bearer s3cret');
  });

  it('turns a POST answered 303 into a bodiless GET', async () => {
    const calls = scripted(to('/result', 303));
    await safeFetch('https://example.com/start', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    });
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].init.body).toBeNull();
    expect(new Headers(calls[1].init.headers).get('content-type')).toBeNull();
  });

  it('resends a POST answered 307 unchanged', async () => {
    const calls = scripted(to('/again', 307));
    await safeFetch('https://example.com/start', { method: 'POST', body: '{"a":1}' });
    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].init.body).toBe('{"a":1}');
  });

  it('keeps a Request input’s method and headers past the first hop', async () => {
    const calls = scripted(to('/moved', 307));
    await safeFetch(
      new Request('https://example.com/start', { method: 'PUT', headers: { 'x-a': '1' } }),
    );
    expect(calls[1].init.method).toBe('PUT');
    expect(new Headers(calls[1].init.headers).get('x-a')).toBe('1');
  });

  it('returns a 304 as the response, not as a redirect without a Location', async () => {
    scripted({ status: 304, headers: new Headers() });
    const res = await safeFetch('https://example.com/cached');
    expect(res.status).toBe(304);
  });
});
