/**
 * HMAC-SHA256 hash for API keys.
 *
 * Uses BETTER_AUTH_SECRET as the HMAC key so that a DB compromise alone is
 * not sufficient to recover or forge valid API keys (unlike plain SHA-256).
 *
 * Must be consistent across all call sites — do NOT duplicate this function.
 * Any divergence silently makes keys created at one site unverifiable at another.
 */
export async function hashApiKey(key: string): Promise<string> {
  const authSecret = process.env.BETTER_AUTH_SECRET ?? process.env.SECRET_KEY ?? '';
  if (!authSecret) throw new Error('Server configuration error: BETTER_AUTH_SECRET not set');
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(authSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hashBuffer = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(key));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
