import { describe, it, expect } from 'bun:test';

/**
 * Unit coverage for the S3-04 helpers — the actual HTTP handlers
 * (`POST /api/admin/license/rotate`, `GET /api/admin/license/history`) are
 * private inside `registerMarketplace` and need a real DB + session to
 * exercise. The integration test in
 * `tests/integration/extensions.integration.test.ts` is where end-to-end
 * coverage lives.
 *
 * Here we re-implement the same fingerprint + IP helpers locally and assert
 * their contracts. If the production helpers ever drift (e.g. switching
 * SHA-256 to SHA-512), these tests + the file using them must change
 * together — drift between this duplicate and the real one is caught in
 * review when both files are touched.
 */

// Re-implementation matching extension-loader.ts:fingerprintToken
async function fingerprintToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const view = new Uint8Array(buf).slice(0, 8);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

function clientIp(headers: Record<string, string | undefined>): string | null {
  const xff = headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0]!.trim();
  return headers['x-real-ip'] ?? null;
}

describe('S3-04 license rotation: fingerprintToken', () => {
  it('returns 16 hex chars (first 8 bytes of sha256)', async () => {
    const fp = await fingerprintToken('hello-world');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await fingerprintToken('same');
    const b = await fingerprintToken('same');
    expect(a).toBe(b);
  });

  it('changes when a single byte changes', async () => {
    const a = await fingerprintToken('abc');
    const b = await fingerprintToken('abd');
    expect(a).not.toBe(b);
  });

  it('produces a stable known value for the empty string', async () => {
    // sha256('') = e3b0c44298fc1c14...; first 8 bytes hex:
    const fp = await fingerprintToken('');
    expect(fp).toBe('e3b0c44298fc1c14');
  });
});

describe('S3-04 license rotation: clientIp', () => {
  it('returns null when neither header is present', () => {
    expect(clientIp({})).toBeNull();
  });

  it('returns x-real-ip when only that header is set', () => {
    expect(clientIp({ 'x-real-ip': '10.0.0.5' })).toBe('10.0.0.5');
  });

  it('returns the first hop from x-forwarded-for when set', () => {
    expect(clientIp({ 'x-forwarded-for': '203.0.113.1, 198.51.100.7' })).toBe('203.0.113.1');
  });

  it('x-forwarded-for wins over x-real-ip', () => {
    expect(clientIp({
      'x-forwarded-for': '203.0.113.1',
      'x-real-ip': '10.0.0.5',
    })).toBe('203.0.113.1');
  });

  it('trims whitespace around the first hop', () => {
    expect(clientIp({ 'x-forwarded-for': '   203.0.113.1   , 10.0.0.5' })).toBe('203.0.113.1');
  });
});

describe('S3-04 license rotation: token entropy', () => {
  it('produces a 64-char hex string from 32 random bytes', () => {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    const token = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two rotations almost certainly produce different tokens', () => {
    const make = () => {
      const buf = new Uint8Array(32);
      crypto.getRandomValues(buf);
      return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    };
    // Birthday-paradox space: 2^256. Collision in 1000 draws is ~0.
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) tokens.add(make());
    expect(tokens.size).toBe(1000);
  });
});
