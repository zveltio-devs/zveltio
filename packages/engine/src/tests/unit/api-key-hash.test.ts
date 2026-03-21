import { describe, it, expect, beforeAll } from 'bun:test';

// hashApiKey requires BETTER_AUTH_SECRET — set it before importing
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = 'unit-test-secret-minimum-32-characters!';
});

const { hashApiKey } = await import('../../lib/api-key-hash.js');

describe('hashApiKey', () => {
  it('returns a 64-character hex string', async () => {
    const hash = await hashApiKey('test-key-123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input produces same hash', async () => {
    const a = await hashApiKey('my-api-key');
    const b = await hashApiKey('my-api-key');
    expect(a).toBe(b);
  });

  it('produces different hashes for different keys', async () => {
    const a = await hashApiKey('key-one');
    const b = await hashApiKey('key-two');
    expect(a).not.toBe(b);
  });
});
