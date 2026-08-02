/**
 * HMAC-signed JSON cache entries.
 *
 * Anything cached in Valkey that an authorization decision is then made from
 * has to be signed, because the cache is a separate process with its own
 * access story: whoever can write a key can rewrite the answer. `checkPermission`
 * and the god-role lookup learned this and sign their booleans; the tenant
 * lookup signs its row. Two caches did not:
 *
 *   - `rls:policies:<collection>` — the row-level filters applied to every
 *     read. Replacing it with `[]` removes the filters, and the query then
 *     returns rows the policy exists to withhold.
 *   - `colperms:<collection>:<role>` — which columns a role may see. Replacing
 *     it with empty sets un-hides every hidden column.
 *
 * Neither needs a login to exploit, only write access to the cache, and both
 * fail quietly: the request succeeds and returns more than it should.
 *
 * A tampered or unreadable entry decodes to `null`, which the callers treat as
 * a miss and answer from the database — fail closed, at the cost of a query.
 *
 * The three older caches each carry their own copy of this logic. They are left
 * alone here rather than refactored under a security fix; this is the shared
 * version for anything new.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

function hmac(namespace: string, key: string, value: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      `[${namespace}] BETTER_AUTH_SECRET is not set — the cache signature would use an ` +
        `empty key and provide no integrity protection. Set it before starting the server.`,
    );
  }
  return createHmac('sha256', secret).update(`${namespace}:${key}:${value}`).digest('hex');
}

/** Serialize + sign. Store the result as the cache value. */
export function encodeSigned(namespace: string, key: string, data: unknown): string {
  const json = JSON.stringify(data);
  return `${hmac(namespace, key, json)}:${json}`;
}

/**
 * Verify + parse. Returns `null` when the entry is missing its signature, was
 * signed for a different key, or does not parse — every one of which means
 * "ask the database instead".
 */
export function decodeSigned<T>(namespace: string, key: string, raw: string): T | null {
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const storedHmac = raw.slice(0, sep);
  const json = raw.slice(sep + 1);
  try {
    const expected = Buffer.from(hmac(namespace, key, json), 'hex');
    const stored = Buffer.from(storedHmac, 'hex');
    if (stored.length !== expected.length) return null;
    if (!timingSafeEqual(stored, expected)) return null;
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
