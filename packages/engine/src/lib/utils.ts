/**
 * Generates a random ID using Bun/browser native crypto.getRandomValues().
 * No external dependency needed — replaces nanoid.
 * @param size Number of characters (default 21, same as nanoid default)
 */
export function generateId(size: number = 21): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const randomValues = new Uint8Array(size);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < size; i++) {
    id += chars[randomValues[i] % chars.length];
  }
  return id;
}
