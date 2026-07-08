/**
 * Extension license helpers (lib/extensions/extension-license.ts) — the pure
 * ones: fingerprintToken (audit-log correlation without storing the token) and
 * clientIp (x-forwarded-for / x-real-ip extraction). The DB read/write helpers
 * are covered by the marketplace integration tests.
 */

import { describe, it, expect } from 'bun:test';
import { clientIp, fingerprintToken } from '../../lib/extensions/extension-license.js';

describe('fingerprintToken', () => {
  it('is a stable 16-char hex digest', async () => {
    const a = await fingerprintToken('secret-token');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await fingerprintToken('secret-token')).toBe(a); // deterministic
  });

  it('differs for different tokens', async () => {
    expect(await fingerprintToken('token-a')).not.toBe(await fingerprintToken('token-b'));
  });
});

describe('clientIp', () => {
  const ctx = (headers: Record<string, string>) => ({
    req: { header: (k: string) => headers[k.toLowerCase()] },
  });

  it('takes the first entry of x-forwarded-for', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
  });

  it('trims whitespace around the forwarded IP', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '  198.51.100.2  , 10.0.0.1' }))).toBe('198.51.100.2');
  });

  it('falls back to x-real-ip when no forwarded header', () => {
    expect(clientIp(ctx({ 'x-real-ip': '192.0.2.9' }))).toBe('192.0.2.9');
  });

  it('returns null when neither header is present', () => {
    expect(clientIp(ctx({}))).toBeNull();
  });
});
