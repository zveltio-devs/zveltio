/**
 * safeFetch — SSRF-proof wrapper for fetch().
 *
 * Blocks: loopback, link-local, RFC1918 private ranges, cloud metadata,
 * Docker/k8s internals. Validation is delegated to the shared url-validator
 * module, and the connection is then made to the address that validation
 * approved — see `pinnedRequest` below for why the second half matters.
 *
 * Everything the platform sends outbound goes through here: webhook deliveries,
 * flow HTTP nodes, virtual collection sources, Web Push. Those URLs are supplied
 * by tenant admins, which is precisely the threat model.
 */

import { assertPublicUrl, validatePublicUrl } from '../security/index.js';
export { validatePublicUrl, assertPublicUrl };

/**
 * Whether an egress proxy is in play.
 *
 * Bun's fetch honours these and the `proxy` init option — measured: with
 * `HTTPS_PROXY` pointed at a dead port, a request fails instead of succeeding.
 * When a proxy opens the connection, the URL it is handed must stay the URL the
 * caller meant; rewriting it underneath is an interaction this code does not
 * claim to have tested, so it does not do it.
 */
function proxyConfigured(init?: RequestInit): boolean {
  if (init && 'proxy' in init && (init as { proxy?: unknown }).proxy) return true;
  return Boolean(
    process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy,
  );
}

/**
 * Point the request at `address` while keeping it addressed to the host.
 *
 * `assertPublicUrl` resolves the name and checks every address it answers.
 * Handing the NAME to `fetch` then resolves it a second time, and only the first
 * resolution was inspected — so a name under someone else's control can answer
 * public to the check and private to the connection. The check is real and the
 * request still lands inside.
 *
 * Requesting the IP with an explicit `Host` header and a TLS `serverName`
 * removes the second resolution: the connection goes where we decided, and the
 * certificate is still presented and verified for the name. Verified against
 * real hosts before this was written — example.com, github.com and
 * cloudflare.com all answer normally this way, CDN fronting included.
 *
 * `address` is null when there is nothing to pin: an IP literal was never a
 * name, and a host that did not resolve cannot be reached by the fetch either.
 */
function pinnedRequest(
  url: string,
  init: RequestInit,
  address: string | null,
): { url: string; init: RequestInit } {
  if (!address || proxyConfigured(init)) return { url, init };

  const parsed = new URL(url);
  const pinned = new URL(url);
  pinned.hostname = address.includes(':') ? `[${address}]` : address;

  const headers = new Headers(init.headers);
  // `host` carries the port when there is one: a vhost is chosen by authority,
  // not by hostname alone.
  headers.set('host', parsed.host);

  const pinnedInit: RequestInit = { ...init, headers };
  if (parsed.protocol === 'https:') {
    // Without serverName the certificate is checked against the IP and every
    // request fails; with it this is an ordinary verified TLS connection, to a
    // host we chose rather than one the resolver chose twice.
    (pinnedInit as { tls?: Record<string, unknown> }).tls = {
      ...((init as { tls?: Record<string, unknown> }).tls ?? {}),
      serverName: parsed.hostname,
    };
  }
  return { url: pinned.toString(), init: pinnedInit };
}

/** Exposed so a test can assert the request shape without opening a socket. */
export const pinnedRequestForTests = pinnedRequest;

export async function safeFetch(
  input: string | URL | Request,
  init?: RequestInit,
  _hops = 0,
): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  // DNS-aware: also rejects hostnames that RESOLVE into private space, which a
  // literal-text blocklist cannot see. Returns the address to connect to.
  const address = await assertPublicUrl(url);

  if (_hops > 5) throw new Error('[safeFetch] Too many redirects.');

  // A `Request` carries its own headers and body, and pinning has to rewrite the
  // URL — so it is unpacked here rather than passed through.
  const baseInit: RequestInit =
    input instanceof Request
      ? { method: input.method, headers: input.headers, body: input.body, ...(init ?? {}) }
      : (init ?? {});

  // Prevent redirect-based SSRF: intercept redirects and re-validate the Location URL.
  const target = pinnedRequest(url, { ...baseInit, redirect: 'manual' }, address);
  const response = await fetch(target.url, target.init);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('[safeFetch] Redirect with no Location header.');
    // Re-validate redirect target to block chains like public.example.com → 169.254.169.254
    return safeFetch(new URL(location, url).toString(), init, _hops + 1);
  }

  return response;
}
