/**
 * Per-field AES-256-GCM encryption for application collection data.
 *
 * Values are written as `enc:v2:<key id>:<base64url(iv|ct+tag)>`, sealed to
 * where they live (`FieldAad`: tenant, collection, field, record — ADR 0059,
 * amendment 2026-11-21). `enc:v1:` values, which bind nothing, stay readable
 * until `rotate-keys` rewrites them.
 *
 * Keys: FIELD_ENCRYPTION_KEYS (comma list, first = current) or
 * FIELD_ENCRYPTION_KEY (one key), 64 hex chars each. Generate with:
 * openssl rand -hex 32
 */

import {
  type FieldAad,
  decryptWithKeyring,
  encryptWithKeyring,
  isFieldEnvelope,
  keyList,
  sealField,
} from '../security/index.js';
import { modeOn } from '../operational-modes.js';

export type { FieldAad } from '../security/index.js';

// Read the key LAZILY (not captured at module load). This module is pulled in by
// the route/write-pipeline import chain, which can evaluate before a test harness
// or a secret loader sets FIELD_ENCRYPTION_KEY — capturing at load time then left
// encryption silently disabled (encrypted:true fields written in PLAINTEXT).
// Reading per-call also lets an operator rotate the key without a restart.
// "Configured" counts a malformed key too: it is refused at encrypt time, never
// read as "no key" (which a plaintext opt-in would then honour).
function keyConfigured(): string {
  const { keys, malformed } = keyList('field');
  return keys.length + malformed.length > 0 ? 'set' : '';
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
  if (keyConfigured()) return; // key is set — nothing to flag
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
// refusal message.
function assertKeyShape(): void {
  if (!keyList('field').currentOk) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY (or the first entry of FIELD_ENCRYPTION_KEYS) must be a ' +
        '64-char hex string (32 bytes). Generate with: openssl rand -hex 32',
    );
  }
}

export function isEncryptedValue(value: unknown): value is string {
  return isFieldEnvelope(value);
}

/** Seal `plaintext` to where it lives (`enc:v2:`). */
export async function encryptField(plaintext: string, aad: FieldAad): Promise<string> {
  assertKeyShape();
  return sealField(plaintext, aad);
}

/**
 * The unbound `enc:v1:` envelope, under the current key — only for the
 * extension surfaces that document it and name no record
 * (`internals.encryptSecret`, `internals.maybeEncrypt`; v2-candidates).
 */
export async function encryptFieldUnbound(plaintext: string): Promise<string> {
  assertKeyShape();
  return encryptWithKeyring(plaintext, 'field');
}

/**
 * Open a field value. `aad` is where it lives: an `enc:v2:` value opens only
 * with the context it was sealed to; an `enc:v1:` one under any listed key.
 */
export async function decryptField(value: string, aad?: FieldAad): Promise<string> {
  if (!isEncryptedValue(value)) return value;
  if (keyList('field').keys.length === 0) assertKeyShape();
  return decryptWithKeyring(value, 'field', aad);
}

/**
 * Encrypt a field value if the field definition has encrypted:true and a field
 * key is set. With `aad` the value is sealed to it (`enc:v2:`); without, it is
 * the unbound `enc:v1:` the extension surface documents.
 */
export async function maybeEncrypt(
  value: unknown,
  isEncrypted: boolean,
  aad?: FieldAad,
): Promise<unknown> {
  if (!isEncrypted || value === null || value === undefined) return value;
  if (typeof value !== 'string') return value; // only encrypt strings
  if (isEncryptedValue(value)) return value; // already encrypted
  if (!keyConfigured()) {
    // Fail-CLOSED: the operator explicitly marked this field `encrypted: true`,
    // so a plaintext string reaching here is data they told us is sensitive
    // (PII / ANSVSA / SAF-T). Silently persisting it in the clear is a data
    // downgrade, so refuse the write — the same posture as BETTER_AUTH_SECRET.
    // An operator who genuinely wants the old degraded behavior must opt in.
    if (modeOn('ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS')) {
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
  return aad ? encryptField(value, aad) : encryptFieldUnbound(value);
}

/** Decrypt a field value if it looks like an encrypted value; `aad` as `decryptField`. */
export async function maybeDecrypt(
  value: unknown,
  isEncrypted: boolean,
  aad?: FieldAad,
): Promise<unknown> {
  if (!isEncrypted || value === null || value === undefined) return value;
  if (typeof value !== 'string' || !isEncryptedValue(value)) return value;
  try {
    return await decryptField(value, aad);
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
