/**
 * SSRF guard (lib/security/url-validator.ts) — validatePublicUrl blocks requests
 * to private/internal addresses (loopback, link-local, RFC1918, cloud metadata)
 * and non-http(s) schemes. Pure + security-critical: used by safeFetch, webhooks,
 * and the edge-function runner before any outbound request.
 */

import { describe, it, expect, test } from 'bun:test';
import { isBlockedHost, validatePublicUrl } from '../../lib/security/url-validator.js';

describe('validatePublicUrl — allows public http(s)', () => {
  it('accepts ordinary public URLs', () => {
    expect(() => validatePublicUrl('https://example.com')).not.toThrow();
    expect(() => validatePublicUrl('http://api.github.com/repos')).not.toThrow();
    expect(() => validatePublicUrl('https://1.1.1.1/')).not.toThrow(); // public IP
  });
});

describe('validatePublicUrl — rejects bad schemes / malformed', () => {
  it('throws on a malformed URL', () => {
    expect(() => validatePublicUrl('not a url')).toThrow(/Invalid URL/);
  });

  it('throws on non-http(s) schemes', () => {
    expect(() => validatePublicUrl('ftp://example.com')).toThrow(/http\/https/);
    expect(() => validatePublicUrl('file:///etc/passwd')).toThrow(/http\/https/);
  });
});

describe('validatePublicUrl — blocks internal/private targets (SSRF)', () => {
  const blocked = [
    'http://localhost',
    'http://127.0.0.1',
    'http://127.0.0.1:8080/admin',
    'http://10.0.0.5',
    'http://192.168.1.1',
    'http://172.16.0.1',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://[::1]', // IPv6 loopback
    'http://[::1]:8080/admin', // IPv6 loopback w/ port
    'http://[fe80::1]', // IPv6 link-local
    'http://[fd00::1]', // IPv6 ULA
    'http://[::ffff:127.0.0.1]', // IPv4-mapped IPv6 loopback (dotted)
    'http://[::ffff:169.254.169.254]', // IPv4-mapped cloud metadata via IPv6
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(() => validatePublicUrl(url)).toThrow(/internal\/private address blocked/);
    });
  }
});

describe('RFC 6598 shared address space', () => {
  // 100.64.0.0/10 was missing because it is not RFC 1918 — it is "carrier-grade
  // NAT" space, which reads like someone else's network. On a managed
  // Kubernetes cluster, a Tailscale network, or several hosting providers, it
  // is where the internal services actually live, so an SSRF that reaches it
  // reaches them.
  test.each([
    '100.64.0.1',
    '100.64.255.255',
    '100.100.50.1',
    '100.127.255.255',
  ])('blocks %s', (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  // The boundaries matter more than the middle: /10 ends at 100.127, and
  // 100.128.0.0 onwards is ordinary public space that has to keep working. A
  // regex written as `100\.(6[4-9]|...)` is easy to get wrong by one octet in
  // either direction, and both mistakes are silent.
  test.each([
    '100.63.255.255',
    '100.128.0.1',
    '100.200.10.5',
    '1.100.64.1',
  ])('leaves %s reachable', (host) => {
    expect(isBlockedHost(host)).toBe(false);
  });
});
