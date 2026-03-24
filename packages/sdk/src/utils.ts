/**
 * UUID v4 generator that works in both secure (HTTPS/localhost) and
 * non-secure (HTTP over LAN/IP) contexts.
 *
 * crypto.randomUUID() requires a secure context (HTTPS or localhost).
 * When accessed over plain HTTP via IP address, we fall back to
 * crypto.getRandomValues() which is available in all contexts.
 */
export function generateUUID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: build UUID v4 from random bytes (works in non-secure contexts)
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant bits
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
