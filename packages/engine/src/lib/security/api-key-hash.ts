import { currentAuthSecret, readAuthSecrets } from './auth-secret.js';

/**
 * HMAC-SHA256 hash for API keys.
 *
 * Uses BETTER_AUTH_SECRET as the HMAC key so that a DB compromise alone is
 * not sufficient to recover or forge valid API keys (unlike plain SHA-256).
 *
 * Must be consistent across all call sites — do NOT duplicate this function.
 * Any divergence silently makes keys created at one site unverifiable at another.
 */
export function generateApiKey(): string {
  return `zvk_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * The shape `generateApiKey` has minted since v1.0.0. Checked before the lookup:
 * any `zvk_` header otherwise cost a query before a limiter could refuse it.
 */
export function isWellFormedApiKey(key: string): boolean {
  return /^zvk_[0-9a-f]{32}$/.test(key);
}

export async function hashApiKey(key: string): Promise<string> {
  // `BETTER_AUTH_SECRET` alone. A `?? process.env.SECRET_KEY` fallback sat here
  // and in the two routes below, and it was unreachable in all three: `initAuth()`
  // throws without `BETTER_AUTH_SECRET`, so the engine cannot reach a request
  // handler in the state the fallback existed for. Eleven other production sites
  // read the variable without it; a second spelling of one secret is a divergence
  // waiting for somebody to add a twelfth site that honours only one of them.
  const authSecret = currentAuthSecret() ?? '';
  if (!authSecret) throw new Error('Server configuration error: BETTER_AUTH_SECRET not set');
  return hmacHex(authSecret, key);
}

/**
 * What `zv_api_keys.key_hash_version` records for a hash `hashApiKey` writes
 * now: the current `BETTER_AUTH_SECRETS` version, or null for `BETTER_AUTH_SECRET`
 * alone (migration 126).
 */
export function currentApiKeyHashVersion(): number | null {
  if (!process.env.BETTER_AUTH_SECRETS) return null;
  return readAuthSecrets().secrets![0]!.version;
}

/**
 * Every hash a key may be stored under, current first: one per listed secret,
 * then `BETTER_AUTH_SECRET` (version null) unless its value is listed. A hash
 * written under a secret that is no longer current still verifies while that
 * secret is held, and `findApiKey` rewrites it (ADR 0058 decision 7). Bounded by
 * the list's length; the same work for every key, found or not.
 */
export async function apiKeyHashCandidates(
  key: string,
): Promise<Array<{ hash: string; version: number | null }>> {
  const { secrets, legacy } = readAuthSecrets();
  const held: Array<{ value: string; version: number | null }> = [...(secrets ?? [])];
  if (legacy && !held.some((s) => s.value === legacy)) held.push({ value: legacy, version: null });
  return Promise.all(
    held.map(async ({ value, version }) => ({ hash: await hmacHex(value, key), version })),
  );
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hashBuffer = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(message));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * What `zv_invitations.token` stores: SHA-256 hex of the token in the link.
 * Not `hashApiKey`'s HMAC: migration 038 must hash the rows that already exist,
 * and the database does not hold BETTER_AUTH_SECRET. Unkeyed is enough for 256
 * random bits — there is nothing to brute-force (same reasoning as Better-Auth's
 * `storeIdentifier: 'hashed'` in lib/auth.ts). Prefixed, so a digest is never
 * mistaken for a raw token: both are 64 hex characters, and the migration that
 * hashes existing rows has to be safe to run twice.
 */
export function hashInvitationToken(token: string): string {
  return `sha256:${new Bun.CryptoHasher('sha256').update(token).digest('hex')}`;
}
