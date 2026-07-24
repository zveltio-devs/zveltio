/**
 * Field encryption helpers (lib/data/field-crypto.ts) — the env-independent
 * branches: the `enc:v1:` marker check + the maybe-encrypt/decrypt guards. (The
 * AES-GCM round-trip needs FIELD_ENCRYPTION_KEY set at module load and is
 * exercised by the security integration suite.)
 */

import { describe, expect, it } from 'bun:test';
import {
  decryptField,
  isEncryptedValue,
  maybeDecrypt,
  maybeEncrypt,
  resetFieldCryptoKeyCacheForTests,
} from '../../lib/data/field-crypto.js';

describe('isEncryptedValue', () => {
  it('true only for an enc:v1: prefixed string', () => {
    expect(isEncryptedValue('enc:v1:abcdef')).toBe(true);
    expect(isEncryptedValue('plaintext')).toBe(false);
    expect(isEncryptedValue('')).toBe(false);
    expect(isEncryptedValue(123)).toBe(false);
    expect(isEncryptedValue(null)).toBe(false);
    expect(isEncryptedValue({ enc: true })).toBe(false);
  });
});

describe('maybeEncrypt — guards independent of the key', () => {
  it('isEncrypted=false → returns the value untouched', async () => {
    expect(await maybeEncrypt('secret', false)).toBe('secret');
  });

  it('null / undefined pass through even when isEncrypted=true', async () => {
    expect(await maybeEncrypt(null, true)).toBeNull();
    expect(await maybeEncrypt(undefined, true)).toBeUndefined();
  });

  it('non-string values are never encrypted', async () => {
    expect(await maybeEncrypt(42, true)).toBe(42);
    expect(await maybeEncrypt(true, true)).toBe(true);
  });

  it('an already-encrypted value is returned as-is', async () => {
    expect(await maybeEncrypt('enc:v1:already', true)).toBe('enc:v1:already');
  });
});

describe('maybeEncrypt — fail-closed when FIELD_ENCRYPTION_KEY is missing', () => {
  const savedKey = process.env.FIELD_ENCRYPTION_KEY;
  const savedOptIn = process.env.ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS;

  const withEnv = async (
    key: string | undefined,
    optIn: string | undefined,
    fn: () => Promise<void>,
  ) => {
    if (key === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = key;
    if (optIn === undefined) delete process.env.ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS;
    else process.env.ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS = optIn;
    try {
      await fn();
    } finally {
      if (savedKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
      else process.env.FIELD_ENCRYPTION_KEY = savedKey;
      if (savedOptIn === undefined) delete process.env.ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS;
      else process.env.ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS = savedOptIn;
    }
  };

  it('a plaintext string with no key THROWS rather than storing plaintext', async () => {
    await withEnv(undefined, undefined, async () => {
      await expect(maybeEncrypt('super-secret', true)).rejects.toThrow(/FIELD_ENCRYPTION_KEY/);
    });
  });

  it('the explicit opt-in restores plaintext degradation', async () => {
    await withEnv(undefined, '1', async () => {
      expect(await maybeEncrypt('super-secret', true)).toBe('super-secret');
    });
  });

  it('a real key encrypts to the enc:v1: envelope (no throw)', async () => {
    resetFieldCryptoKeyCacheForTests();
    await withEnv('0'.repeat(64), undefined, async () => {
      const out = (await maybeEncrypt('super-secret', true)) as string;
      expect(out.startsWith('enc:v1:')).toBe(true);
    });
    // Don't leak the test key's cached CryptoKey into other test files.
    resetFieldCryptoKeyCacheForTests();
  });
});

describe('maybeDecrypt / decryptField — passthrough guards', () => {
  it('isEncrypted=false → returns the value', async () => {
    expect(await maybeDecrypt('secret', false)).toBe('secret');
  });

  it('null / undefined pass through', async () => {
    expect(await maybeDecrypt(null, true)).toBeNull();
    expect(await maybeDecrypt(undefined, true)).toBeUndefined();
  });

  it('a non-encrypted string is returned unchanged', async () => {
    expect(await maybeDecrypt('plaintext', true)).toBe('plaintext');
    expect(await decryptField('plaintext')).toBe('plaintext');
  });
});
