/**
 * Generates a random ID using Bun/browser native crypto.getRandomValues().
 * No external dependency needed — replaces nanoid.
 * @param size Number of characters (default 21, same as nanoid default)
 */
export function generateId(size: number = 21): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // Bytes at or above 248 (= 4 * 62) are dropped: `byte % 62` over the full
  // 0-255 range would favour the first 8 characters.
  const limit = 256 - (256 % chars.length);
  let id = '';
  const randomValues = new Uint8Array(size * 2);
  while (id.length < size) {
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < randomValues.length && id.length < size; i++) {
      if (randomValues[i] < limit) id += chars[randomValues[i] % chars.length];
    }
  }
  return id;
}
