/**
 * safeFetch — SSRF-proof wrapper for fetch().
 * Blocks: loopback, link-local, RFC1918 private ranges, cloud metadata, Docker/k8s internals.
 * Validation is delegated to the shared url-validator module.
 */

import { validatePublicUrl } from '../security/url-validator.js';
export { validatePublicUrl };

export async function safeFetch(
  input: string | URL | Request,
  init?: RequestInit,
  _hops = 0,
): Promise<Response> {
  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.toString()
    : input.url;

  validatePublicUrl(url);

  if (_hops > 5) throw new Error('[safeFetch] Too many redirects.');

  // Prevent redirect-based SSRF: intercept redirects and re-validate the Location URL.
  const response = await fetch(input, { ...(init ?? {}), redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('[safeFetch] Redirect with no Location header.');
    // Re-validate redirect target to block chains like public.example.com → 169.254.169.254
    return safeFetch(new URL(location, url).toString(), init, _hops + 1);
  }

  return response;
}
