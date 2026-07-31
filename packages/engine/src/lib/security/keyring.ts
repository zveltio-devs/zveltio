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
 *   field  `enc:v1:<base64url(iv|ct+tag)>`      FIELD_ENCRYPTION_KEY  (engine)
 *          `enc1:<base64(iv|tag|ct)>`            …legacy, read-only    (migrators)
 *   mail   `aes256gcm:<ivHex>:<ctHex+tag>`       MAIL_ENCRYPTION_KEY   (mail)
 *
 * `enc1:` is decrypt-only. It differs from the engine's own layout in one
 * detail — Node's `createCipheriv` hands back the GCM tag separately, so the
 * extension stored `iv|tag|ct` while WebCrypto expects the tag appended to the
 * ciphertext. Reading it means moving 16 bytes, not keeping a second cipher.
 * Anything re-encrypted comes back as `enc:v1:`, so the format drains as rows
 * are rewritten instead of needing a migration that must decrypt every row in
 * one shot.
 *
 * A keyring is NOT a permission boundary between extensions — anything holding
 * `secrets` can name any keyring. It exists so key material stays on the host
 * and so blast radius stays separated the way the deployment intended: mail
 * passwords are under their own key, and rotating it does not touch field data.
 */

export type Keyring = 'field' | 'mail';

const FIELD_PREFIX = 'enc:v1:';
/** Legacy envelope written by integrations/migrators. Decrypt-only. */
const LEGACY_ENC1_PREFIX = 'enc1:';
const MAIL_PREFIX = 'aes256gcm:';

/** Read keys per call, never at module load — see field-crypto for the why. */
function keyHexFor(keyring: Keyring): string {
  const raw =
    keyring === 'mail' ? process.env.MAIL_ENCRYPTION_KEY : process.env.FIELD_ENCRYPTION_KEY;
  return (raw ?? '').trim();
}

export class MissingKeyError extends Error {
  constructor(readonly keyring: Keyring) {
    const env = keyring === 'mail' ? 'MAIL_ENCRYPTION_KEY' : 'FIELD_ENCRYPTION_KEY';
    super(
      `${env} is not set, so the "${keyring}" keyring cannot encrypt or decrypt. ` +
        `Generate one with \`openssl rand -hex 32\`.`,
    );
    this.name = 'MissingKeyError';
  }
}

async function importKey(keyring: Keyring, usage: KeyUsage[]): Promise<CryptoKey> {
  const hex = keyHexFor(keyring);
  // The mail extension sliced to 64 hex chars, tolerating a longer value.
  // Reproduced so a deployment with an over-long key keeps decrypting.
  const usable = hex.slice(0, 64);
  if (usable.length < 64 || !/^[0-9a-fA-F]{64}$/.test(usable)) throw new MissingKeyError(keyring);
  return crypto.subtle.importKey('raw', fromHex(usable), { name: 'AES-GCM' }, false, usage);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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
      value.startsWith(LEGACY_ENC1_PREFIX) ||
      value.startsWith(MAIL_PREFIX))
  );
}

/** Encrypt with the named keyring, in that keyring's current format. */
export async function encryptWithKeyring(plaintext: string, keyring: Keyring): Promise<string> {
  const key = await importKey(keyring, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );

  if (keyring === 'mail') {
    return `${MAIL_PREFIX}${toHex(iv)}:${toHex(ct)}`;
  }
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return (
    FIELD_PREFIX + toBase64(combined).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  );
}

/**
 * Decrypt any envelope this module knows, choosing the key from the envelope
 * rather than the caller's word for it. A value that carries no known prefix is
 * returned untouched — both mail passwords and migrator tokens have rows that
 * predate encryption, and throwing on those would turn "this was stored before
 * we encrypted anything" into a hard failure at read time.
 */
export async function decryptWithKeyring(value: string, keyring: Keyring): Promise<string> {
  if (typeof value !== 'string' || !isKeyringValue(value)) return value;

  if (value.startsWith(MAIL_PREFIX)) {
    const [, ivHex, ctHex] = value.split(':');
    const key = await importKey('mail', ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(ivHex) },
      key,
      fromHex(ctHex),
    );
    return new TextDecoder().decode(plain);
  }

  if (value.startsWith(LEGACY_ENC1_PREFIX)) {
    // iv(12) | tag(16) | ct  →  WebCrypto wants iv, then ct with the tag appended.
    const raw = fromBase64(value.slice(LEGACY_ENC1_PREFIX.length));
    const iv = new Uint8Array(raw.slice(0, 12));
    const tag = raw.slice(12, 28);
    const ct = raw.slice(28);
    const joined = new Uint8Array(ct.length + tag.length);
    joined.set(ct, 0);
    joined.set(tag, ct.length);
    const key = await importKey('field', ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, joined);
    return new TextDecoder().decode(plain);
  }

  const b64 = value.slice(FIELD_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  const combined = fromBase64(b64);
  const key = await importKey(keyring === 'mail' ? 'mail' : 'field', ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(combined.slice(0, 12)) },
    key,
    new Uint8Array(combined.slice(12)),
  );
  return new TextDecoder().decode(plain);
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
  const secret = process.env.BETTER_AUTH_SECRET ?? '';
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
