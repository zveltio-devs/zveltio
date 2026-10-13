/**
 * Per-field AES-256-GCM encryption for application collection data.
 *
 * Encrypted values are stored with the prefix "enc:v1:" followed by
 * base64url-encoded "<12-byte IV>:<ciphertext>".
 *
 * Requires env var: FIELD_ENCRYPTION_KEY (64 hex chars = 32 bytes)
 * Generate with: openssl rand -hex 32
 */

import { decryptWithKeyring, encryptWithKeyring } from '../security/index.js';

const ENC_PREFIX = 'enc:v1:';

// Read the key LAZILY (not captured at module load). This module is pulled in by
// the route/write-pipeline import chain, which can evaluate before a test harness
// or a secret loader sets FIELD_ENCRYPTION_KEY — capturing at load time then left
// encryption silently disabled (encrypted:true fields written in PLAINTEXT).
// Reading per-call also lets an operator rotate the key without a restart.
function keyHex(): string {
  return process.env.FIELD_ENCRYPTION_KEY ?? '';
}

let _missingKeyWarned = false;
function warnMissingKeyOnce(): void {
  if (_missingKeyWarned) return;
  _missingKeyWarned = true;
  console.warn(
    '[field-crypto] WARNING: FIELD_ENCRYPTION_KEY is not set — fields ' +
      'marked `encrypted: true` are being stored in PLAINTEXT. Generate ' +
      'a key with `openssl rand -hex 32` and set FIELD_ENCRYPTION_KEY.',
  );
}

/**
 * Boot-time check: are there any collection fields configured with
 * `encrypted: true` while FIELD_ENCRYPTION_KEY is unset? If yes, log a
 * loud warning so an operator notices that sensitive data is going to
 * disk in the clear instead of failing silently the first time someone
 * writes to one of those fields.
 */
export async function checkFieldEncryptionAtBoot(
  db: import('../../db/index.js').Database,
): Promise<void> {
  if (keyHex()) return; // key is set — nothing to flag
  try {
    const rows = (await db
      .selectFrom('zvd_collections')
      .select(['name', 'fields'])
      .execute()) as Array<{ name: string; fields: unknown }>;
    const collectionsWithEncrypted: string[] = [];
    for (const row of rows) {
      const fields =
        typeof row.fields === 'string'
          ? (() => {
              try {
                return JSON.parse(row.fields as string);
              } catch {
                return [];
              }
            })()
          : // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
            (row.fields as any);
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      if (Array.isArray(fields) && fields.some((f: any) => f?.encrypted === true)) {
        collectionsWithEncrypted.push(row.name);
      }
    }
    if (collectionsWithEncrypted.length > 0) {
      console.warn(
        `[field-crypto] WARNING: ${collectionsWithEncrypted.length} ` +
          `collection(s) have fields marked encrypted but FIELD_ENCRYPTION_KEY ` +
          `is not set: ${collectionsWithEncrypted.join(', ')}. ` +
          `Those fields are being stored in PLAINTEXT. ` +
          `Generate a key with \`openssl rand -hex 32\` and set ` +
          `FIELD_ENCRYPTION_KEY before writing more sensitive data.`,
      );
    }
  } catch {
    /* zvd_collections may not exist yet on a brand new install */
  }
}

// The cipher itself is the keyring's (`security/keyring.ts`): two copies of the
// enc:v1 format drifted once already. What stays here is the field key's
// stricter shape check — the keyring tolerates an over-long key for mail.
function assertKeyShape(): void {
  // Hex, not just 64 characters: `parseInt('zz', 16)` is NaN, which a
  // Uint8Array stores as 0 — so 64 non-hex characters imported as an all-zero
  // AES key and encrypted without a word.
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex())) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY env var must be set to a 64-char hex string (32 bytes). ' +
        'Generate with: openssl rand -hex 32',
    );
  }
}

export function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export async function encryptField(plaintext: string): Promise<string> {
  assertKeyShape();
  return encryptWithKeyring(plaintext, 'field');
}

export async function decryptField(value: string): Promise<string> {
  if (!isEncryptedValue(value)) return value;
  assertKeyShape();
  return decryptWithKeyring(value, 'field');
}

/** Encrypt a field value if the field definition has encrypted:true and FIELD_ENCRYPTION_KEY is set */
export async function maybeEncrypt(value: unknown, isEncrypted: boolean): Promise<unknown> {
  if (!isEncrypted || value === null || value === undefined) return value;
  if (typeof value !== 'string') return value; // only encrypt strings
  if (isEncryptedValue(value)) return value; // already encrypted
  if (!keyHex()) {
    // Fail-CLOSED: the operator explicitly marked this field `encrypted: true`,
    // so a plaintext string reaching here is data they told us is sensitive
    // (PII / ANSVSA / SAF-T). Silently persisting it in the clear is a data
    // downgrade, so refuse the write — the same posture as BETTER_AUTH_SECRET.
    // An operator who genuinely wants the old degraded behavior must opt in.
    if (process.env.ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS === '1') {
      warnMissingKeyOnce();
      return value;
    }
    throw new Error(
      'FIELD_ENCRYPTION_KEY is not set but a field is marked `encrypted: true` — ' +
        'refusing to write sensitive data in plaintext. Set FIELD_ENCRYPTION_KEY ' +
        '(`openssl rand -hex 32`), or set ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS=1 ' +
        'to explicitly allow plaintext storage.',
    );
  }
  return encryptField(value);
}

/** Decrypt a field value if it looks like an encrypted value */
export async function maybeDecrypt(value: unknown, isEncrypted: boolean): Promise<unknown> {
  if (!isEncrypted || value === null || value === undefined) return value;
  if (typeof value !== 'string' || !isEncryptedValue(value)) return value;
  try {
    return await decryptField(value);
  } catch (err) {
    // Log so a rotated/missing key shows up in the operator's logs
    // instead of silently surfacing `enc:v1:...` strings to clients.
    // Still return the value as-is — failing the read would lock the
    // whole record, which is worse for ops than a noisy log line.
    console.error(
      '[field-crypto] decryptField failed — wrong FIELD_ENCRYPTION_KEY ' +
        'or corrupted ciphertext. Returning value as-is.',
      err instanceof Error ? err.message : err,
    );
    return value;
  }
}
