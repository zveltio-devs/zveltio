/**
 * The platform's outbound fetch connects to the address it validated.
 *
 * `assertPublicUrl` resolves a hostname and checks every address it answers —
 * and then the NAME was handed to `fetch`, which resolves it again. Two
 * resolutions, one inspected: an attacker-controlled name can answer public to
 * the check and private to the connection. The check is real and the request
 * still lands inside.
 *
 * This is the same repair already made inside the edge-function sandboxes,
 * applied where the rest of the platform goes out: webhook deliveries, flow HTTP
 * nodes, virtual collection sources, Web Push. Those are the paths where the URL
 * is supplied by a tenant admin, which is exactly the threat.
 *
 * Verified against real hosts before it was written — `https://example.com/`,
 * `https://github.com/`, `https://cloudflare.com/` all answer normally when the
 * request goes to their IP with a `Host` header and a TLS `serverName`, CDN
 * fronting included.
 *
 * An egress proxy is the documented exception. Bun's fetch honours `HTTPS_PROXY`
 * and the `proxy` option — measured — and a proxy is then the thing that opens
 * the connection, so rewriting the URL underneath it is an interaction this
 * change does not claim to have tested. With a proxy configured the behaviour is
 * exactly what it was before.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { pinnedRequestForTests } from '../../lib/edge-functions/safe-fetch.js';

const previousProxy = process.env.HTTPS_PROXY;

afterEach(() => {
  if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = previousProxy;
});

describe('safeFetch — connecting to the validated address', () => {
  it('requests the IP and carries the name in Host and TLS serverName', () => {
    const pinned = pinnedRequestForTests('https://example.com/hook?x=1', {}, '93.184.216.34');

    // The name is gone from the URL — that is the point: there is no second
    // resolution left to answer differently.
    expect(pinned.url).toBe('https://93.184.216.34/hook?x=1');
    expect(new Headers(pinned.init.headers).get('host')).toBe('example.com');
    expect((pinned.init as { tls?: { serverName?: string } }).tls?.serverName).toBe('example.com');
  });

  it('keeps the port in Host, because a vhost is chosen by authority', () => {
    const pinned = pinnedRequestForTests('http://example.com:8080/hook', {}, '93.184.216.34');

    expect(pinned.url).toBe('http://93.184.216.34:8080/hook');
    expect(new Headers(pinned.init.headers).get('host')).toBe('example.com:8080');
    // Plain HTTP has no certificate to check, so no serverName is set.
    expect((pinned.init as { tls?: unknown }).tls).toBeUndefined();
  });

  it('brackets an IPv6 address rather than producing an unparseable URL', () => {
    const pinned = pinnedRequestForTests('https://example.com/', {}, '2606:2800:220:1:248:1893::');

    expect(pinned.url).toBe('https://[2606:2800:220:1:248:1893::]/');
  });

  it('leaves the request alone when there is nothing to pin', () => {
    // An IP literal was never a name, and a host that did not resolve cannot be
    // reached by the fetch either.
    const pinned = pinnedRequestForTests('https://93.184.216.34/x', { method: 'POST' }, null);

    expect(pinned.url).toBe('https://93.184.216.34/x');
    expect(new Headers(pinned.init.headers ?? {}).get('host')).toBeNull();
  });

  it('preserves the caller’s own headers and body', () => {
    const pinned = pinnedRequestForTests(
      'https://example.com/hook',
      { method: 'POST', body: '{"a":1}', headers: { 'x-zveltio-signature': 'sig' } },
      '93.184.216.34',
    );

    expect(pinned.init.method).toBe('POST');
    expect(pinned.init.body).toBe('{"a":1}');
    expect(new Headers(pinned.init.headers).get('x-zveltio-signature')).toBe('sig');
  });

  it('does not rewrite anything when an egress proxy is configured', () => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';

    const pinned = pinnedRequestForTests('https://example.com/hook', {}, '93.184.216.34');

    // The proxy opens the connection, so the URL it is given must stay the URL
    // the caller meant. Unpinned here is the same behaviour as before this
    // change, not a regression introduced by it.
    expect(pinned.url).toBe('https://example.com/hook');
    expect((pinned.init as { tls?: unknown }).tls).toBeUndefined();
  });
});
