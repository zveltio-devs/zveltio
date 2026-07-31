/**
 * Byte-compatibility with the ciphertext three extensions already wrote.
 *
 * auth/scim, communications/mail and integrations/migrators each did their own
 * AES-GCM/HMAC with a key read from `process.env`. Moving that onto the host
 * removes the ambient key access — but their output is already on disk in
 * installs we do not control, so "it decrypts what they wrote" is the property
 * that decides whether this is a refactor or data loss.
 *
 * These tests therefore do not test the keyring against itself. They reproduce
 * the OLD implementations here, verbatim, and check the host reads them.
 */

import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  MissingKeyError,
  decryptWithKeyring,
  encryptWithKeyring,
  hmacAuthSecret,
  isKeyringValue,
} from '../../lib/security/keyring.js';

const FIELD_KEY = 'a3f1'.repeat(16); // 64 hex chars
const MAIL_KEY = 'b7c2'.repeat(16);
const AUTH_SECRET = 'test-better-auth-secret-value-32ch';

let saved: Record<string, string | undefined>;

beforeAll(() => {
  saved = {
    FIELD_ENCRYPTION_KEY: process.env.FIELD_ENCRYPTION_KEY,
    MAIL_ENCRYPTION_KEY: process.env.MAIL_ENCRYPTION_KEY,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  };
  process.env.FIELD_ENCRYPTION_KEY = FIELD_KEY;
  process.env.MAIL_ENCRYPTION_KEY = MAIL_KEY;
  process.env.BETTER_AUTH_SECRET = AUTH_SECRET;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── The old implementations, copied from the extensions ─────────────────────

/** integrations/migrators — `enc1:` + base64(iv|tag|ct), FIELD_ENCRYPTION_KEY. */
function oldMigratorsEncrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(FIELD_KEY, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

/** communications/mail — `aes256gcm:<ivHex>:<cipherHex>`, MAIL_ENCRYPTION_KEY. */
async function oldMailEncrypt(plain: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    Buffer.from(MAIL_KEY.slice(0, 64), 'hex'),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    keyMaterial,
    new TextEncoder().encode(plain),
  );
  return `aes256gcm:${Buffer.from(iv).toString('hex')}:${Buffer.from(encrypted).toString('hex')}`;
}

/** auth/scim — HMAC-SHA256 of the raw token under BETTER_AUTH_SECRET. */
function oldScimHash(raw: string): string {
  return createHmac('sha256', AUTH_SECRET).update(raw).digest('hex');
}

// ── The property that matters ───────────────────────────────────────────────

describe('reads what integrations/migrators already wrote', () => {
  it('decrypts an enc1: token', async () => {
    const stored = oldMigratorsEncrypt('ghp_secret_token_value');
    expect(stored.startsWith('enc1:')).toBe(true);
    expect(await decryptWithKeyring(stored, 'field')).toBe('ghp_secret_token_value');
  });

  it('handles values with multi-byte characters and empty strings', async () => {
    for (const plain of ['', 'ăîâșț — ünïcode', 'x'.repeat(5000)]) {
      expect(await decryptWithKeyring(oldMigratorsEncrypt(plain), 'field')).toBe(plain);
    }
  });

  it('re-encrypts into the current format, so enc1: drains as rows are rewritten', async () => {
    const migrated = await encryptWithKeyring('ghp_secret_token_value', 'field');
    expect(migrated.startsWith('enc:v1:')).toBe(true);
    expect(await decryptWithKeyring(migrated, 'field')).toBe('ghp_secret_token_value');
  });

  it('rejects a tampered enc1: value instead of returning garbage', async () => {
    const stored = oldMigratorsEncrypt('secret');
    const tampered = `enc1:${Buffer.from(
      Buffer.from(stored.slice(5), 'base64').map((b, i) => (i === 30 ? b ^ 0xff : b)),
    ).toString('base64')}`;
    await expect(decryptWithKeyring(tampered, 'field')).rejects.toThrow();
  });
});

describe('reads what communications/mail already wrote', () => {
  it('decrypts an aes256gcm: password', async () => {
    const stored = await oldMailEncrypt('imap-password-1');
    expect(await decryptWithKeyring(stored, 'mail')).toBe('imap-password-1');
  });

  it('round-trips in the same format the extension wrote', async () => {
    const mine = await encryptWithKeyring('smtp-pw', 'mail');
    expect(mine.startsWith('aes256gcm:')).toBe(true);
    expect(await decryptWithKeyring(mine, 'mail')).toBe('smtp-pw');
  });

  it('uses the mail key, not the field key', async () => {
    // Blast-radius separation is the reason MAIL_ENCRYPTION_KEY exists at all.
    // If this passed under the field key, the separation would be cosmetic.
    const stored = await oldMailEncrypt('imap-password-1');
    const savedMail = process.env.MAIL_ENCRYPTION_KEY;
    process.env.MAIL_ENCRYPTION_KEY = 'c9d4'.repeat(16);
    await expect(decryptWithKeyring(stored, 'mail')).rejects.toThrow();
    process.env.MAIL_ENCRYPTION_KEY = savedMail;
  });
});

describe('reproduces the scim token hash exactly', () => {
  it('matches the old HMAC, so issued tokens keep authenticating', async () => {
    for (const raw of ['zvscim_abc123', '', 'ünïcode-token']) {
      expect(await hmacAuthSecret(raw)).toBe(oldScimHash(raw));
    }
  });
});

describe('values that predate encryption', () => {
  it('passes a bare plaintext through instead of throwing at read time', async () => {
    // Both mail passwords and migrator tokens have rows written before either
    // extension encrypted anything. Throwing would turn old data into an outage.
    expect(await decryptWithKeyring('plain-old-password', 'mail')).toBe('plain-old-password');
    expect(isKeyringValue('plain-old-password')).toBe(false);
  });
});

describe('a missing key fails loudly', () => {
  it('names the environment variable rather than writing plaintext', async () => {
    const savedKey = process.env.MAIL_ENCRYPTION_KEY;
    delete process.env.MAIL_ENCRYPTION_KEY;
    await expect(encryptWithKeyring('x', 'mail')).rejects.toThrow(MissingKeyError);
    await expect(encryptWithKeyring('x', 'mail')).rejects.toThrow('MAIL_ENCRYPTION_KEY');
    process.env.MAIL_ENCRYPTION_KEY = savedKey;
  });
});
