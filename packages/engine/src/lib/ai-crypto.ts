/**
 * AES-256-GCM encryption for AI API keys.
 * Requires env var: AI_KEY_ENCRYPTION_KEY (32 bytes hex)
 * Falls back to MAIL_ENCRYPTION_KEY if AI_KEY_ENCRYPTION_KEY is not set.
 */
function getKey(): string {
  const key =
    process.env.AI_KEY_ENCRYPTION_KEY || process.env.MAIL_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error(
      'AI_KEY_ENCRYPTION_KEY env var must be set. Generate: openssl rand -hex 32',
    );
  }
  return key;
}

export async function encryptApiKey(plaintext: string): Promise<string> {
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
  return `aes256gcm:${Buffer.from(iv).toString('hex')}:${Buffer.from(encrypted).toString('hex')}`;
}

export async function decryptApiKey(stored: string): Promise<string> {
  if (!stored || !stored.startsWith('aes256gcm:')) return stored;
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

export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.startsWith('aes256gcm:')) return '***encrypted***';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}
