/**
 * Field encryption helpers (lib/data/field-crypto.ts) — the env-independent
 * branches: the `enc:v1:` marker check + the maybe-encrypt/decrypt guards. (The
 * AES-GCM round-trip needs FIELD_ENCRYPTION_KEY set at module load and is
 * exercised by the security integration suite.)
 */

import { describe, expect, it } from 'bun:test';
import {
  decryptField,
  encryptField,
  isEncryptedValue,
  maybeDecrypt,
  maybeEncrypt,
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

describe('encryptField — key validation', () => {
  it('rejects encryption when FIELD_ENCRYPTION_KEY is missing or wrong length', async () => {
    const saved = process.env.FIELD_ENCRYPTION_KEY;
    process.env.FIELD_ENCRYPTION_KEY = 'tooshort';
    try {
      await expect(encryptField('secret')).rejects.toThrow(/64-char hex/);
    } finally {
      if (saved === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
      else process.env.FIELD_ENCRYPTION_KEY = saved;
    }
  });
});
