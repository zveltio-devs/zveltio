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
import {
  decryptField,
  encryptField,
  encryptFieldUnbound,
  maybeDecrypt,
} from '../../lib/data/field-crypto.js';
import {
  decryptWithKeyring,
  encryptWithKeyring,
  fieldKeyId,
  keyList,
} from '../../lib/security/keyring.js';

const KEY_A = '1'.repeat(64);
const KEY_B = '2'.repeat(64);

const VARS = [
  'FIELD_ENCRYPTION_KEY',
  'FIELD_ENCRYPTION_KEYS',
  'MAIL_ENCRYPTION_KEY',
  'MAIL_ENCRYPTION_KEYS',
] as const;
let saved: Record<string, string | undefined> = {};

beforeAll(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
});
afterAll(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

/** Only `vars` set among the key variables. */
function keys(vars: Partial<Record<(typeof VARS)[number], string>>): void {
  for (const v of VARS) delete process.env[v];
  Object.assign(process.env, vars);
}

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
    keys({ FIELD_ENCRYPTION_KEY: KEY_A });
    await encryptFieldUnbound('warm the cache under key A');

    // Rotate — an operator setting a new env var, NOT calling any test-only
    // reset hook. The module must notice on its own.
    process.env.FIELD_ENCRYPTION_KEY = KEY_B;
    const encUnderB = await encryptFieldUnbound('sealed after rotation');

    // Decrypt with KEY_B directly, bypassing the module entirely. If the
    // module were still using the cached KEY_A, this raw-KEY_B decrypt fails.
    await expect(decryptWithRawKey(KEY_B, encUnderB)).resolves.toBe('sealed after rotation');
  });
});

/** Where the value lives: what a v2 envelope is sealed to (ADR 0059 amendment). */
const AT = {
  tenant: '00000000-0000-0000-0000-000000000001',
  collection: 'customers',
  field: 'iban',
  record: '5f0c8a52-6a1e-4f0e-9a43-1f0b2c3d4e5f',
};

/** The v1 envelope exactly as the engine wrote it before ADR 0059: no AAD, no key id. */
async function oldV1Encrypt(hex: string, plain: string): Promise<string> {
  const raw = new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)),
  );
  const all = new Uint8Array([...iv, ...ct]);
  return `enc:v1:${Buffer.from(all).toString('base64url')}`;
}

describe('key list (ADR 0059 decision 1)', () => {
  it('reads a v2 value sealed under key 2 once key 1 is current', async () => {
    keys({ FIELD_ENCRYPTION_KEY: KEY_A });
    const old = await encryptField('under A', AT);
    keys({ FIELD_ENCRYPTION_KEYS: `${KEY_B},${KEY_A}` });
    expect(await decryptField(old, AT)).toBe('under A');
    // Dropped from the list, it no longer opens: the list is what reads.
    keys({ FIELD_ENCRYPTION_KEYS: KEY_B });
    await expect(decryptField(old, AT)).rejects.toThrow();
  });

  it('reads a v1 value written under key 2, by the old code, with or without a context', async () => {
    const old = await oldV1Encrypt(KEY_A, 'v1 under A');
    keys({ FIELD_ENCRYPTION_KEYS: `${KEY_B}, ${KEY_A}` });
    expect(await decryptField(old)).toBe('v1 under A');
    expect(await decryptField(old, AT)).toBe('v1 under A');
    expect(await maybeDecrypt(old, true, AT)).toBe('v1 under A');
  });

  it('writes with the first key, named by its id', async () => {
    keys({ FIELD_ENCRYPTION_KEYS: `${KEY_B},${KEY_A}` });
    const v = await encryptField('new', AT);
    expect(v.startsWith(`enc:v2:${fieldKeyId(KEY_B)}:`)).toBe(true);
    expect(await decryptWithRawKey(KEY_B, await encryptFieldUnbound('new v1'))).toBe('new v1');
  });

  it('the single variable is a one-element list', async () => {
    keys({ FIELD_ENCRYPTION_KEY: KEY_A });
    expect(keyList('field').keys).toEqual([KEY_A]);
    expect(await decryptField(await encryptField('x', AT), AT)).toBe('x');
  });

  it('skips a malformed older entry and refuses a malformed current one, naming no value', async () => {
    keys({ FIELD_ENCRYPTION_KEY: KEY_A });
    const old = await encryptField('under A', AT);
    keys({ FIELD_ENCRYPTION_KEYS: `${KEY_B},not-a-key,${KEY_A}` });
    expect(keyList('field')).toMatchObject({
      keys: [KEY_B, KEY_A],
      currentOk: true,
      malformed: [2],
    });
    expect(await decryptField(old, AT)).toBe('under A');
    keys({ FIELD_ENCRYPTION_KEYS: `not-a-key,${KEY_A}` });
    await expect(encryptField('x', AT)).rejects.toThrow(/64-char hex/);
    expect(await decryptField(old, AT)).toBe('under A');
  });

  it('the single variable stays readable after the list, once', async () => {
    keys({ FIELD_ENCRYPTION_KEY: KEY_A });
    const old = await encryptField('under A', AT);
    keys({ FIELD_ENCRYPTION_KEY: KEY_A, FIELD_ENCRYPTION_KEYS: KEY_B });
    expect(keyList('field').keys).toEqual([KEY_B, KEY_A]);
    expect(await decryptField(old, AT)).toBe('under A');
    expect((await encryptField('new', AT)).startsWith(`enc:v2:${fieldKeyId(KEY_B)}:`)).toBe(true);
    keys({ FIELD_ENCRYPTION_KEY: KEY_A, FIELD_ENCRYPTION_KEYS: `${KEY_A},${KEY_B}` });
    expect(keyList('field').keys).toEqual([KEY_A, KEY_B]);
  });

  it('numbers a malformed entry by its place in the list, empty entries counted', () => {
    keys({ FIELD_ENCRYPTION_KEYS: `${KEY_B},,not-a-key` });
    expect(keyList('field').malformed).toEqual([3]);
  });

  it('the mail keyring takes a list too', async () => {
    const MAIL_A = 'a'.repeat(64);
    keys({ MAIL_ENCRYPTION_KEY: MAIL_A });
    const old = await encryptWithKeyring('smtp-pass', 'mail');
    keys({ MAIL_ENCRYPTION_KEYS: `${'b'.repeat(64)},${MAIL_A}` });
    expect(await decryptWithKeyring(old, 'mail')).toBe('smtp-pass');
  });
});

describe('enc:v2: is sealed to where it lives (ADR 0059 amendment)', () => {
  it('does not open when moved to another tenant, collection, field or record', async () => {
    keys({ FIELD_ENCRYPTION_KEY: KEY_A });
    const v = await encryptField('IBAN RO49', AT);
    expect(await decryptField(v, AT)).toBe('IBAN RO49');
    for (const moved of [
      { ...AT, tenant: '00000000-0000-0000-0000-000000000002' },
      { ...AT, collection: 'suppliers' },
      { ...AT, field: 'note' },
      { ...AT, record: '5f0c8a52-6a1e-4f0e-9a43-1f0b2c3d4e60' },
    ]) {
      await expect(decryptField(v, moved)).rejects.toThrow();
      // The read path keeps the record readable and the value sealed.
      expect(await maybeDecrypt(v, true, moved)).toBe(v);
    }
    await expect(decryptField(v)).rejects.toThrow(/bound/);
  });

  it('refuses a tampered value, an unknown key id and a value naming no key', async () => {
    keys({ FIELD_ENCRYPTION_KEY: KEY_A });
    const v = await encryptField('x', AT);
    const last = v.at(-2) === 'A' ? 'B' : 'A';
    await expect(decryptField(`${v.slice(0, -2)}${last}${v.at(-1)}`, AT)).rejects.toThrow();
    const body = v.slice('enc:v2:'.length);
    await expect(decryptField(`enc:v2:${fieldKeyId(KEY_B)}${body.slice(8)}`, AT)).rejects.toThrow(
      /No configured field key/,
    );
    await expect(decryptField(`enc:v2:${body.slice(9)}`, AT)).rejects.toThrow(/names no key id/);
  });

  it('a record id spelled another way Postgres accepts is the same record', async () => {
    keys({ FIELD_ENCRYPTION_KEY: KEY_A });
    const v = await encryptField('x', { ...AT, record: AT.record.toUpperCase() });
    expect(await decryptField(v, { ...AT, record: AT.record.replace(/-/g, '') })).toBe('x');
  });
});
