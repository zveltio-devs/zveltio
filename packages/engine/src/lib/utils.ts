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

/**
 * A list route's `?page=&limit=` as a LIMIT and an OFFSET Postgres accepts.
 * Malformed input (`page=0`, `limit=-1`, `abc`) falls back to the first page
 * and the route's default size: it used to reach SQL as NaN or a negative,
 * which Postgres refuses, so a typo in a query string answered 500.
 */
export function paging(
  page: string | undefined,
  limit: string | undefined,
  size: number,
  max: number,
): { page: number; limit: number; offset: number } {
  const lim = Math.min(Math.max(parseInt(limit ?? '', 10) || size, 1), max);
  // Capped so the offset stays a safe integer rather than `1e+22` in the SQL.
  const p = Math.min(Math.max(parseInt(page ?? '', 10) || 1, 1), Math.floor(2 ** 31 / lim));
  return { page: p, limit: lim, offset: (p - 1) * lim };
}
