/**
 * FIELD_ENCRYPTION_KEY rotation without a restart.
 *
 * `keyHex()` in field-crypto.ts is deliberately read lazily, per the comment
 * at its definition, "to let an operator rotate the key without a restart".
 * `getKey()` used to cache the imported CryptoKey on first use and never
 * re-check the env var, so that promise was false: every write for the rest
 * of the process stayed sealed under whichever key was live at the first
 * encrypt/decrypt call, with nothing to observe from the outside (the same
 * stale key also decrypts anything it just encrypted, so a same-process
 * round-trip test cannot tell the two apart).
 *
 * This test decrypts independently of the module's own cache — with raw
 * WebCrypto, from the hex the operator actually set second — so it fails
 * against the caching bug and passes once getKey() re-imports on a changed key.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { encryptField, resetFieldCryptoKeyCacheForTests } from '../../lib/data/field-crypto.js';

const KEY_A = '1'.repeat(64);
const KEY_B = '2'.repeat(64);

let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.FIELD_ENCRYPTION_KEY;
});
afterAll(() => {
  resetFieldCryptoKeyCacheForTests();
  if (savedKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = savedKey;
});

async function decryptWithRawKey(hex: string, enc: string): Promise<string> {
  const raw = new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  const b64 = enc.slice('enc:v1:'.length).replace(/-/g, '+').replace(/_/g, '/');
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

describe('FIELD_ENCRYPTION_KEY rotation', () => {
  it('picks up a rotated key on the next call, without a process restart', async () => {
    resetFieldCryptoKeyCacheForTests();
    process.env.FIELD_ENCRYPTION_KEY = KEY_A;
    await encryptField('warm the cache under key A');

    // Rotate — an operator setting a new env var, NOT calling any test-only
    // reset hook. The module must notice on its own.
    process.env.FIELD_ENCRYPTION_KEY = KEY_B;
    const encUnderB = await encryptField('sealed after rotation');

    // Decrypt with KEY_B directly, bypassing the module entirely. If the
    // module were still using the cached KEY_A, this raw-KEY_B decrypt fails.
    await expect(decryptWithRawKey(KEY_B, encUnderB)).resolves.toBe('sealed after rotation');
  });
});
