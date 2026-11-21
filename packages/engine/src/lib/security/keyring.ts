/**
 * Named encryption keys for extensions, with the envelope formats they already
 * wrote on disk.
 *
 * Three extensions did their own AES-256-GCM because there was no way to ask
 * the host to do it with a key other than the field key. Each read its key
 * straight out of `process.env`, which is the whole ambient-authority problem in
 * miniature: an extension holding `FIELD_ENCRYPTION_KEY` has the `secrets`
 * capability whether or not it declared it, and holds the key for every OTHER
 * extension's data too.
 *
 * Moving them onto the host is not a refactor, because their ciphertext is
 * already on disk in installs we do not control. So this module reproduces each
 * envelope EXACTLY rather than migrating anyone:
 *
 *   field  `enc:v2:<kid>:<base64url(iv|ct+tag)>` FIELD_ENCRYPTION_KEYS (engine, ADR 0059:
 *                                                  AAD = tenant, collection, field, record)
 *          `enc:v1:<base64url(iv|ct+tag)>`      …unbound; the extension surfaces still write it
 *          `enc1:<base64(iv|tag|ct)>`            …legacy, read-only    (migrators)
 *   mail   `aes256gcm:<ivHex>:<ctHex+tag>`       MAIL_ENCRYPTION_KEYS  (mail)
 *
 * Each keyring is a key list, current first (`keyList`); every read tries the
 * listed keys, so a value under an older key stays readable (ADR 0059).
 *
 * `enc1:` is decrypt-only. It differs from the engine's own layout in one
 * detail — Node's `createCipheriv` hands back the GCM tag separately, so the
 * extension stored `iv|tag|ct` while WebCrypto expects the tag appended to the
 * ciphertext. Reading it means moving 16 bytes, not keeping a second cipher.
 * Anything re-encrypted comes back in a current format, so `enc1:` drains as
 * rows are rewritten instead of needing a migration that must decrypt every row
 * in one shot.
 *
 * A keyring is NOT a permission boundary between extensions — anything holding
 * `secrets` can name any keyring. It exists so key material stays on the host
 * and so blast radius stays separated the way the deployment intended: mail
 * passwords are under their own key, and rotating it does not touch field data.
 */

import { createHash } from 'node:crypto';
import { currentAuthSecret } from './auth-secret.js';

export type Keyring = 'field' | 'mail';

/**
 * The keyring a caller named, refused when it is none of ours. An extension
 * passes the name from untyped JS: a misspelt or retired one (`'ai'`) used to
 * seal with the field key without a word, under a blast radius the deployment
 * never chose.
 */
export function assertKeyring(keyring: unknown): Keyring {
  if (keyring === 'field' || keyring === 'mail') return keyring;
  throw new Error(`Unknown keyring ${JSON.stringify(keyring)}: use "field" or "mail".`);
}

const FIELD_PREFIX = 'enc:v1:';
/**
 * The field envelope since ADR 0059 (amendment 2026-11-21):
 * `enc:v2:<key id>:<base64url(iv|ct+tag)>`, sealed with associated data that
 * names where the value lives (`FieldAad`). A v2 value copied to another row,
 * field, collection or tenant fails its tag; `enc:v1:` bound nothing, so a
 * ciphertext from anywhere decrypted anywhere (A14).
 */
const FIELD_V2_PREFIX = 'enc:v2:';
/** Legacy envelope written by integrations/migrators. Decrypt-only. */
const LEGACY_ENC1_PREFIX = 'enc1:';
const MAIL_PREFIX = 'aes256gcm:';

type Env = Record<string, string | undefined>;

const ENV_NAMES: Record<Keyring, { single: string; list: string }> = {
  field: { single: 'FIELD_ENCRYPTION_KEY', list: 'FIELD_ENCRYPTION_KEYS' },
  mail: { single: 'MAIL_ENCRYPTION_KEY', list: 'MAIL_ENCRYPTION_KEYS' },
};

export interface KeyList {
  /** The usable keys, 64 hex each; the current one first when it is usable. */
  keys: string[];
  /** Whether entry 1, the key every write uses, is usable. */
  currentOk: boolean;
  /** 1-based positions of entries that are not a key; never their values. */
  malformed: number[];
  /** The variable the list came from, for messages. */
  source: string;
}

/**
 * A keyring's keys (ADR 0059 decision 1), read per call, never at module load
 * (see field-crypto for the why). `FIELD_ENCRYPTION_KEYS` / `MAIL_ENCRYPTION_KEYS`
 * is a comma list, first = current: writes use it, reads try every key. Without
 * the list the single variable is a one-element list. An entry that is not a key
 * is skipped and reported here, so a typo in an old key cannot turn into "no
 * key at all"; only a malformed CURRENT key refuses the boot (startup guard).
 */
export function keyList(keyring: Keyring, env: Env = process.env): KeyList {
  const names = ENV_NAMES[keyring];
  const listed = env[names.list]?.trim();
  const source = listed ? names.list : names.single;
  const single = env[names.single]?.trim() ?? '';
  // The single variable stays readable next to the list: values sealed under it
  // before the list was set must not turn unreadable without a word.
  const raw = listed ? [...listed.split(','), single] : [single];
  const entries = raw.map((e, i) => [e.trim(), i] as const).filter(([e, i]) => e !== '' || i === 0);
  if (entries.length === 1 && entries[0][0] === '') {
    return { keys: [], currentOk: false, malformed: [], source };
  }
  const keys: string[] = [];
  const malformed: number[] = [];
  entries.forEach(([hex, i]) => {
    // The mail extension sliced to 64 hex chars, tolerating a longer value.
    // Reproduced so a deployment with an over-long mail key keeps decrypting.
    // The field key is held to exactly 64: `parseInt('zz', 16)` is NaN, which a
    // Uint8Array stores as 0, so 64 non-hex characters imported as an all-zero
    // AES key and encrypted without a word.
    const usable = keyring === 'mail' ? hex.slice(0, 64) : hex;
    if (/^[0-9a-fA-F]{64}$/.test(usable)) {
      if (!keys.includes(usable.toLowerCase())) keys.push(usable.toLowerCase());
    } else malformed.push(i + 1);
  });
  return { keys, currentOk: !malformed.includes(1), malformed, source };
}

export class MissingKeyError extends Error {
  constructor(readonly keyring: Keyring) {
    const env = ENV_NAMES[keyring].single;
    super(
      `${env} (or ${ENV_NAMES[keyring].list}) has no usable current key, so the "${keyring}" ` +
        `keyring cannot encrypt or decrypt. Generate one with \`openssl rand -hex 32\`.`,
    );
    this.name = 'MissingKeyError';
  }
}

/** The key every write uses: entry 1, refused when it is unset or malformed. */
function currentKey(keyring: Keyring): string {
  const list = keyList(keyring);
  if (!list.currentOk) throw new MissingKeyError(keyring);
  return list.keys[0]!;
}

/** Every usable key, for trial decryption; refused when there is none. */
function readKeys(keyring: Keyring): string[] {
  const { keys } = keyList(keyring);
  if (keys.length === 0) throw new MissingKeyError(keyring);
  return keys;
}

// Keyed by the key itself, so a rotated variable is a new entry, not a stale hit.
const imported = new Map<string, Promise<CryptoKey>>();
function importKey(hex: string): Promise<CryptoKey> {
  let k = imported.get(hex);
  if (!k) {
    k = crypto.subtle.importKey('raw', fromHex(hex), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    imported.set(hex, k);
  }
  return k;
}

/**
 * The key id a v2 envelope carries: 8 hex of a domain-separated SHA-256 of the
 * key. Derived, not configured, so the list stays plain keys and a reader finds
 * the key without trying them all; 32 bits name a handful of keys, and a
 * collision only costs a second trial.
 */
export function fieldKeyId(hex: string): string {
  return createHash('sha256')
    .update('zveltio field key id\0')
    .update(Buffer.from(hex, 'hex'))
    .digest('hex')
    .slice(0, 8);
}

/**
 * Where a field value lives — the associated data of its `enc:v2:` envelope.
 * `tenant` is the row's `tenant_id` ('' for an instance-wide setting),
 * `collection` the collection name (an engine table goes by `$<name>`, which
 * no collection can be called), `field` the column, `record` the row id.
 */
export interface FieldAad {
  tenant: string;
  collection: string;
  field: string;
  record: string;
}

/**
 * A uuid in the one text form Postgres hands back (lower case, hyphenated), so
 * an id a caller spelled `{A0EE…}` or without hyphens binds the same row it is
 * stored as.
 */
function canonicalId(v: string): string {
  const h = v.replace(/[{}-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) return v;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function aadBytes(aad: FieldAad): Uint8Array<ArrayBuffer> {
  const parts = [canonicalId(aad.tenant), aad.collection, aad.field, canonicalId(aad.record)];
  for (const p of parts) {
    if (p.includes('\0')) throw new Error('Field encryption context cannot contain NUL.');
  }
  if (!aad.collection || !aad.field || !aad.record) {
    throw new Error('Field encryption needs the collection, field and record it is bound to.');
  }
  return new TextEncoder().encode(parts.join('\0'));
}

function toBase64(bytes: Uint8Array): string {
  // Not btoa(String.fromCharCode(...bytes)): spreading a large array as call
  // arguments overflows the stack, and a ~1 MB field value then failed to
  // encrypt with "Maximum call stack size exceeded".
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const fromBase64Url = (s: string) => fromBase64(s.replace(/-/g, '+').replace(/_/g, '/'));

/** The envelope of the `ai` keyring ai 1.x used; refused on read. */
const RETIRED_AI_PREFIX = 'aes256gcm-ai:';

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const pairs = hex.match(/../g) ?? [];
  const out = new Uint8Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) out[i] = Number.parseInt(pairs[i], 16);
  return out;
}

/** Whether a stored value carries an envelope this module understands. */
export function isKeyringValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith(FIELD_PREFIX) ||
      value.startsWith(FIELD_V2_PREFIX) ||
      value.startsWith(LEGACY_ENC1_PREFIX) ||
      value.startsWith(MAIL_PREFIX))
  );
}

/** Whether a value is field ciphertext, either version. */
export function isFieldEnvelope(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith(FIELD_PREFIX) || value.startsWith(FIELD_V2_PREFIX))
  );
}

/** Whether a value is a v2 field envelope, sealed to where it lives. */
export function isBoundFieldValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(FIELD_V2_PREFIX);
}

async function gcmEncrypt(
  hex: string,
  plaintext: string,
  additionalData?: Uint8Array<ArrayBuffer>,
): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params: AesGcmParams = additionalData
    ? { name: 'AES-GCM', iv, additionalData }
    : { name: 'AES-GCM', iv };
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(params, await importKey(hex), new TextEncoder().encode(plaintext)),
  );
  return { iv, ct };
}

/**
 * Decrypt under each key in turn (AES-GCM fails fast on a wrong key's tag) —
 * how a value written under an older key stays readable (ADR 0059 decision 1).
 */
async function trialDecrypt(
  keys: string[],
  iv: Uint8Array<ArrayBuffer>,
  ct: Uint8Array<ArrayBuffer>,
  additionalData?: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const params: AesGcmParams = additionalData
    ? { name: 'AES-GCM', iv, additionalData }
    : { name: 'AES-GCM', iv };
  let last: unknown;
  for (const hex of keys) {
    try {
      return new TextDecoder().decode(
        await crypto.subtle.decrypt(params, await importKey(hex), ct),
      );
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('The value does not decrypt under any key.');
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Encrypt with the named keyring's current key, in that keyring's unbound
 * format: `enc:v1:` for field, `aes256gcm:` for mail. The extension surfaces
 * (`internals.encryptSecret`, `maybeEncrypt`) document `enc:v1:` and name no
 * record, so they keep it (frozen v1; their narrowing is v2-candidates). The
 * engine's own field values are sealed by `sealField`.
 */
export async function encryptWithKeyring(plaintext: string, keyring: Keyring): Promise<string> {
  assertKeyring(keyring);
  const { iv, ct } = await gcmEncrypt(currentKey(keyring), plaintext);
  if (keyring === 'mail') return `${MAIL_PREFIX}${toHex(iv)}:${toHex(ct)}`;
  return FIELD_PREFIX + toBase64Url(concat(iv, ct));
}

/** Seal a field value to where it lives, under the current field key (`enc:v2:`). */
export async function sealField(plaintext: string, aad: FieldAad): Promise<string> {
  const hex = currentKey('field');
  const { iv, ct } = await gcmEncrypt(hex, plaintext, aadBytes(aad));
  return `${FIELD_V2_PREFIX}${fieldKeyId(hex)}:${toBase64Url(concat(iv, ct))}`;
}

/**
 * Decrypt any envelope this module knows, choosing the key from the envelope
 * rather than the caller's word for it. A value that carries no known prefix is
 * returned untouched — both mail passwords and migrator tokens have rows that
 * predate encryption, and throwing on those would turn "this was stored before
 * we encrypted anything" into a hard failure at read time.
 *
 * `aad` is where the value lives: a v2 envelope opens only with it, and only
 * with the one it was sealed to. v1, `enc1:` and mail envelopes bind nothing
 * and ignore it.
 */
export async function decryptWithKeyring(
  value: string,
  keyring: Keyring,
  aad?: FieldAad,
): Promise<string> {
  assertKeyring(keyring);
  // The `ai` keyring is gone (ADR 0027). Its envelope is ciphertext, not a
  // value from before encryption: returned as is, it would pass as the
  // credential and be wrapped again on the next save. Refuse it.
  if (typeof value === 'string' && value.startsWith(RETIRED_AI_PREFIX)) {
    throw new Error(
      'A value sealed with the retired "ai" keyring cannot be read; store the secret again.',
    );
  }
  if (typeof value !== 'string' || !isKeyringValue(value)) return value;

  if (value.startsWith(MAIL_PREFIX)) {
    const [ivHex, ctHex] = value.slice(MAIL_PREFIX.length).split(':');
    return trialDecrypt(readKeys('mail'), fromHex(ivHex ?? ''), fromHex(ctHex ?? ''));
  }

  if (value.startsWith(LEGACY_ENC1_PREFIX)) {
    // iv(12) | tag(16) | ct  →  WebCrypto wants iv, then ct with the tag appended.
    const raw = fromBase64(value.slice(LEGACY_ENC1_PREFIX.length));
    const joined = new Uint8Array(concat(raw.slice(28), raw.slice(12, 28)));
    return trialDecrypt(readKeys('field'), new Uint8Array(raw.slice(0, 12)), joined);
  }

  // A v2 value is always the field key's; a v1 one under the keyring named.
  const v1Mail = keyring === 'mail' && !value.startsWith(FIELD_V2_PREFIX);
  return openField(value, readKeys(v1Mail ? 'mail' : 'field'), aad);
}

/** Open an `enc:v2:` or `enc:v1:` value under `keys`; throws when none opens it. */
async function openField(value: string, keys: string[], aad?: FieldAad): Promise<string> {
  if (value.startsWith(FIELD_V2_PREFIX)) {
    if (!aad) {
      throw new Error(
        'An enc:v2: value opens only with the record it is bound to; this caller names none.',
      );
    }
    const body = value.slice(FIELD_V2_PREFIX.length);
    const sep = body.indexOf(':');
    if (sep < 0) throw new Error('An enc:v2: value names no key id.');
    const kid = body.slice(0, sep);
    const named = keys.filter((hex) => fieldKeyId(hex) === kid);
    if (named.length === 0) {
      throw new Error(`No configured field key has id ${JSON.stringify(kid)}.`);
    }
    const combined = fromBase64Url(body.slice(sep + 1));
    return trialDecrypt(
      named,
      new Uint8Array(combined.slice(0, 12)),
      new Uint8Array(combined.slice(12)),
      aadBytes(aad),
    );
  }
  const combined = fromBase64Url(value.slice(FIELD_PREFIX.length));
  return trialDecrypt(
    keys,
    new Uint8Array(combined.slice(0, 12)),
    new Uint8Array(combined.slice(12)),
  );
}

/**
 * Which listed field key opens `value` where it lives (`aad`), and what it
 * holds — for `rotate-keys` (ADR 0059 decision 2). Null when no listed key
 * opens it: such a value is reported, never rewritten. Without `aad` only an
 * `enc:v1:` value can open. `current` is whether
 * that key is the one writes use.
 */
export async function openFieldValue(
  value: string,
  aad?: FieldAad,
): Promise<{ plaintext: string; keyId: string; current: boolean } | null> {
  const keys = readKeys('field');
  for (const [i, hex] of keys.entries()) {
    try {
      const plaintext = await openField(value, [hex], aad);
      return { plaintext, keyId: fieldKeyId(hex), current: i === 0 && keyList('field').currentOk };
    } catch {
      // Not this key (or not this row): try the next.
    }
  }
  return null;
}

/**
 * HMAC-SHA256 of `raw` under the instance auth secret, hex encoded.
 *
 * Exists for auth/scim, which stores a hash of each SCIM bearer token rather
 * than the token. It read `BETTER_AUTH_SECRET` to do it; holding that secret is
 * strictly more power than being able to compute this one hash, so moving the
 * computation here is a reduction even though the output is unchanged.
 *
 * The output IS deliberately unchanged: every SCIM token already issued is
 * matched against a hash computed this exact way, and domain-separating the
 * input now would invalidate all of them on upgrade. New callers should not
 * reuse this — it is a compatibility surface, not a general-purpose MAC.
 */
export async function hmacAuthSecret(raw: string): Promise<string> {
  const secret = currentAuthSecret() ?? '';
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to derive token hashes');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return toHex(new Uint8Array(sig));
}
