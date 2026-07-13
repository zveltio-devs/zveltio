/**
 * registry-keys.ts — trusted Ed25519 pubkey loading from env + builtins.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { findKeyById, getTrustedKeys, hexToBytes } from '../../lib/security/registry-keys.js';

const VALID_HEX = '7c9182ab9015d40f9199b7e282357e3ea21d6697c2c51a7c43ca9dfc9a7fc123';

describe('hexToBytes', () => {
  it('parses 32-byte hex pubkeys', () => {
    expect(hexToBytes(VALID_HEX)).toHaveLength(32);
  });

  it('rejects odd-length hex strings', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd length/);
  });

  it('rejects non-hex characters', () => {
    expect(() =>
      hexToBytes('zz9182ab9015d40f9199b7e282357e3ea21d6697c2c51a7c43ca9dfc9a7fc123'),
    ).toThrow(/invalid hex byte/);
  });
});

describe('getTrustedKeys / findKeyById', () => {
  const saved = process.env.REGISTRY_PUBLIC_KEYS_JSON;

  afterEach(() => {
    if (saved === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
    else process.env.REGISTRY_PUBLIC_KEYS_JSON = saved;
  });

  it('includes the built-in production registry key', () => {
    expect(findKeyById('registry-prod-2026')).not.toBeNull();
  });

  it('warns and ignores invalid REGISTRY_PUBLIC_KEYS_JSON', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    process.env.REGISTRY_PUBLIC_KEYS_JSON = '{bad-json';
    try {
      expect(getTrustedKeys().some((k) => k.keyId === 'registry-prod-2026')).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('not valid JSON'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when the env var is not a JSON array', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify({ keyId: 'x' });
    try {
      expect(getTrustedKeys()).toHaveLength(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('must be a JSON array'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips entries with missing fields or invalid pubkey length', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
      { keyId: 'bad-len', publicKeyHex: 'aabb' },
      { keyId: 'missing-hex' },
      { keyId: 'mirror-ok', publicKeyHex: VALID_HEX },
    ]);
    try {
      expect(findKeyById('mirror-ok')).not.toBeNull();
      expect(findKeyById('bad-len')).toBeNull();
      expect(warn.mock.calls.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});
