/**
 * AES-256-GCM round-trip coverage for data/field-crypto.ts.
 *
 * The sibling field-crypto.test.ts only covers the key-independent guard
 * branches — the actual encrypt/decrypt path used to require the key at module
 * load. Since field-crypto now reads FIELD_ENCRYPTION_KEY lazily (fix #75), the
 * round-trip is unit-testable: set the key in beforeAll, exercise
 * encryptField / decryptField / maybeEncrypt / maybeDecrypt, and the
 * boot-time check.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  checkFieldEncryptionAtBoot,
  decryptField,
  encryptField,
  isEncryptedValue,
  maybeDecrypt,
  maybeEncrypt,
  resetFieldCryptoKeyCacheForTests,
} from '../../lib/data/field-crypto.js';
import { CannedDb } from './fixtures/canned-db.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex = 32 bytes
let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY = KEY;
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = savedKey;
});

describe('encryptField / decryptField', () => {
  it('rejects encryption when FIELD_ENCRYPTION_KEY is the wrong length', async () => {
    resetFieldCryptoKeyCacheForTests();
    const saved = process.env.FIELD_ENCRYPTION_KEY;
    process.env.FIELD_ENCRYPTION_KEY = 'tooshort';
    try {
      await expect(encryptField('secret')).rejects.toThrow(/64-char hex/);
    } finally {
      resetFieldCryptoKeyCacheForTests();
      process.env.FIELD_ENCRYPTION_KEY = saved ?? KEY;
    }
  });

  it('produces an enc:v1: ciphertext that is not the plaintext', async () => {
    const enc = await encryptField('super-secret-value');
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(enc).not.toContain('super-secret-value');
    expect(isEncryptedValue(enc)).toBe(true);
  });

  it('round-trips plaintext through encrypt → decrypt', async () => {
    for (const plain of ['hello', '', 'unicode: café ☕ 日本語', JSON.stringify({ a: 1 })]) {
      const enc = await encryptField(plain);
      expect(await decryptField(enc)).toBe(plain);
    }
  });

  it('uses a fresh IV each time (same plaintext → different ciphertext)', async () => {
    const a = await encryptField('same');
    const b = await encryptField('same');
    expect(a).not.toBe(b);
    expect(await decryptField(a)).toBe('same');
    expect(await decryptField(b)).toBe('same');
  });

  it('decryptField returns a non-encrypted value unchanged', async () => {
    expect(await decryptField('plain text')).toBe('plain text');
  });
});

describe('maybeEncrypt / maybeDecrypt with a key present', () => {
  it('encrypts a flagged string and decrypts it back', async () => {
    const enc = await maybeEncrypt('pii@example.com', true);
    expect(typeof enc).toBe('string');
    expect((enc as string).startsWith('enc:v1:')).toBe(true);
    expect(await maybeDecrypt(enc, true)).toBe('pii@example.com');
  });

  it('maybeDecrypt returns the value as-is when the ciphertext is corrupted', async () => {
    // valid prefix but garbage body → crypto.subtle.decrypt throws → caught,
    // value returned unchanged (a locked record is worse than a noisy log).
    const corrupted = 'enc:v1:not-valid-base64-$$$';
    expect(await maybeDecrypt(corrupted, true)).toBe(corrupted);
  });
});

describe('checkFieldEncryptionAtBoot', () => {
  it('returns immediately (no DB query) when the key is set', async () => {
    const db = new CannedDb();
    db.fail(/zvd_collections/i, new Error('should not be queried'));
    await expect(
      checkFieldEncryptionAtBoot(db.kysely as unknown as Database),
    ).resolves.toBeUndefined();
    expect(db.executed(/zvd_collections/i).length).toBe(0);
  });

  it('warns about encrypted-but-unprotected collections when the key is missing', async () => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warns.push(a.join(' '));
    try {
      const db = new CannedDb();
      db.when(/zvd_collections/i, [
        { name: 'people', fields: JSON.stringify([{ name: 'ssn', encrypted: true }]) },
        { name: 'plain', fields: JSON.stringify([{ name: 'note' }]) },
      ]);
      await checkFieldEncryptionAtBoot(db.kysely as unknown as Database);
    } finally {
      console.warn = orig;
      process.env.FIELD_ENCRYPTION_KEY = KEY;
    }
    expect(warns.join('\n')).toMatch(/people/);
    expect(warns.join('\n')).not.toMatch(/\bplain\b/);
  });

  it('ignores collections whose fields JSON is malformed', async () => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warns.push(a.join(' '));
    try {
      const db = new CannedDb();
      db.when(/zvd_collections/i, [
        { name: 'broken', fields: '{not-json' },
        { name: 'secure', fields: JSON.stringify([{ name: 'token', encrypted: true }]) },
      ]);
      await checkFieldEncryptionAtBoot(db.kysely as unknown as Database);
    } finally {
      console.warn = orig;
      process.env.FIELD_ENCRYPTION_KEY = KEY;
    }
    expect(warns.join('\n')).toMatch(/secure/);
    expect(warns.join('\n')).not.toMatch(/\bbroken\b/);
  });

  it('swallows DB errors when zvd_collections is unavailable', async () => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    const db = new CannedDb();
    db.fail(/zvd_collections/i, new Error('relation does not exist'));
    await expect(
      checkFieldEncryptionAtBoot(db.kysely as unknown as Database),
    ).resolves.toBeUndefined();
    process.env.FIELD_ENCRYPTION_KEY = KEY;
  });
});
