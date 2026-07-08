/**
 * SSRF guard (lib/security/url-validator.ts) — validatePublicUrl blocks requests
 * to private/internal addresses (loopback, link-local, RFC1918, cloud metadata)
 * and non-http(s) schemes. Pure + security-critical: used by safeFetch, webhooks,
 * and the edge-function runner before any outbound request.
 */

import { describe, it, expect } from 'bun:test';
import { validatePublicUrl } from '../../lib/security/url-validator.js';

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
