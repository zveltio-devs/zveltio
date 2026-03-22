/**
 * Per-field AES-256-GCM encryption for application collection data.
 *
 * Encrypted values are stored with the prefix "enc:v1:" followed by
 * base64url-encoded "<12-byte IV>:<ciphertext>".
 *
 * Requires env var: FIELD_ENCRYPTION_KEY (64 hex chars = 32 bytes)
 * Generate with: openssl rand -hex 32
 */

const ENC_PREFIX = 'enc:v1:';
const KEY_HEX = process.env.FIELD_ENCRYPTION_KEY ?? '';

let _key: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (_key) return _key;
  if (!KEY_HEX || KEY_HEX.length !== 64) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY env var must be set to a 64-char hex string (32 bytes). ' +
      'Generate with: openssl rand -hex 32',
    );
  }
  const raw = new Uint8Array(KEY_HEX.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  _key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return _key;
}

export function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export async function encryptField(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.byteLength + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.byteLength);
  return ENC_PREFIX + btoa(String.fromCharCode(...combined)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function decryptField(value: string): Promise<string> {
  if (!isEncryptedValue(value)) return value;
  const key = await getKey();
  const b64 = value.slice(ENC_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

/** Encrypt a field value if the field definition has encrypted:true and FIELD_ENCRYPTION_KEY is set */
export async function maybeEncrypt(value: unknown, isEncrypted: boolean): Promise<unknown> {
  if (!isEncrypted || value === null || value === undefined) return value;
  if (!KEY_HEX) return value; // graceful degradation if key not set
  if (typeof value !== 'string') return value; // only encrypt strings
  if (isEncryptedValue(value)) return value; // already encrypted
  return encryptField(value);
}

/** Decrypt a field value if it looks like an encrypted value */
export async function maybeDecrypt(value: unknown, isEncrypted: boolean): Promise<unknown> {
  if (!isEncrypted || value === null || value === undefined) return value;
  if (typeof value !== 'string' || !isEncryptedValue(value)) return value;
  try {
    return await decryptField(value);
  } catch {
    return value; // return as-is if decryption fails (wrong key, corrupted)
  }
}
