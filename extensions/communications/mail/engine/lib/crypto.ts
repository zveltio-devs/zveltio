/**
 * Criptare AES-256-GCM pentru parole IMAP/SMTP.
 * Necesită env var: MAIL_ENCRYPTION_KEY (32 bytes hex, generat cu: openssl rand -hex 32)
 */

function getKey(): string {
  const key = process.env.MAIL_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error(
      'MAIL_ENCRYPTION_KEY env var must be set to a 32+ character hex string. ' +
      'Generate with: openssl rand -hex 32',
    );
  }
  return key;
}

export async function encryptPassword(plaintext: string): Promise<string> {
  if (!plaintext) return '';
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    Buffer.from(getKey().slice(0, 64), 'hex'),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    keyMaterial,
    new TextEncoder().encode(plaintext),
  );
  const ivHex = Buffer.from(iv).toString('hex');
  const cipherHex = Buffer.from(encrypted).toString('hex');
  return `aes256gcm:${ivHex}:${cipherHex}`;
}

export async function decryptPassword(stored: string): Promise<string> {
  if (!stored) return '';
  if (!stored.startsWith('aes256gcm:')) return stored; // legacy plaintext — returnează as-is
  const [, ivHex, cipherHex] = stored.split(':');
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    Buffer.from(getKey().slice(0, 64), 'hex'),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(ivHex, 'hex') },
    keyMaterial,
    Buffer.from(cipherHex, 'hex'),
  );
  return new TextDecoder().decode(decrypted);
}
