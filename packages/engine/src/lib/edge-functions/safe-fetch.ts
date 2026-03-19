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
): Promise<Response> {
  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.toString()
    : input.url;

  validatePublicUrl(url);
  return fetch(input, init);
}
