/**
 * `total` for `?as_of=`, remembered across pages.
 *
 * ── The cost, measured ────────────────────────────────────────
 *
 * A time-travel page is cheap and its `total` is not, and the gap is structural
 * rather than a missing index. On 200 000 records with 400 000 revisions, single
 * tenant — the shape a typical install has, because multi-tenancy is a FEATURE
 * here and not the default deployment:
 *
 *     page  (LIMIT 25)                    0,25 ms   reads 49 rows
 *     count (DISTINCT ON + count)       262    ms   reads all 400 000
 *
 * The page stops early: the index yields `record_id` order, so `LIMIT` ends the
 * scan after 25 groups. The count cannot — knowing how many records existed at a
 * point in time means visiting every revision up to it.
 *
 * Four formulations were measured before writing this, and none of them helps:
 *
 *     DISTINCT ON (current)            262 ms
 *     GROUP BY record_id               243 ms
 *     count(DISTINCT record_id)        228 ms
 *     loose index scan (recursive)   4 397 ms   ← 17x WORSE
 *
 * The last is the instructive failure: skipping to each next distinct
 * `record_id` costs 200 000 index descents, dearer than one scan of 400 000
 * entries. There is no cheaper SQL. There is only asking less often.
 *
 * ── Why this is safe to remember at all ───────────────────────
 *
 * The answer for a FIXED `as_of` in the past does not change. Revisions are
 * append-only and stamped `created_at = now()`, so a new one always falls
 * outside a past window's `created_at <= as_of`. That is what makes this
 * different from caching a live query, and it drives the two decisions below.
 *
 * **Not indexed under the collection.** `invalidateQueryCache` drops
 * `qc_keys:{tenant}:{collection}` on every write. For a live query that is
 * right. For a past count it is pure loss: the number cannot have changed, and
 * indexing it there would mean anyone paging through history while others write
 * never gets a hit.
 *
 * **Indexed under the user anyway.** Not because the index is what makes an
 * authorization change safe — the key already encodes the resolved rules, so a
 * changed rule lands on a DIFFERENT key by itself, and `time-travel-count.test`
 * pins that. The index is what stops the superseded key from sitting in Redis
 * for the rest of its TTL, and it is the net for any authorization input that
 * shapes the answer without appearing in that serialisation.
 * `invalidateUserPermCache` reaches it through `invalidateUserQueryCache`,
 * which is the function that actually clears `user:qc-keys:{userId}`.
 *
 * `as_of` in the FUTURE is never remembered: it would cover revisions written
 * after the fact, so the immutability argument does not hold there.
 */

import { createHash } from 'node:crypto';
import { getCache } from '../runtime/index.js';

/**
 * Longer than the query cache's 10 s, and deliberately so: that TTL bounds how
 * stale a LIVE result may be, while this number is immutable for its key. The
 * limit here is only how long a permission change could go unnoticed if its
 * invalidation were missed, so minutes rather than seconds.
 */
const TTL_SECONDS = 300;

export function timeTravelCountKey(parts: {
  tenantId: string | null;
  collection: string;
  asOf: string;
  userId: string;
  /** Serialised row-rule conditions — what this caller is allowed to count. */
  filters: string;
}): string {
  const hash = createHash('sha256')
    .update([parts.asOf, parts.userId, parts.filters].join('|'))
    .digest('hex')
    .slice(0, 16);
  return `ttc:${parts.tenantId ?? '_'}:${parts.collection}:${hash}`;
}

/** The remembered count, or null to compute it. Never throws. */
export async function getTimeTravelCount(key: string): Promise<number | null> {
  const cache = getCache();
  if (!cache) return null;
  try {
    const val = await cache.get(key);
    if (val === null) return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Remember a count. Never throws: a cache that is down must slow the page, not
 * fail it.
 */
export async function setTimeTravelCount(
  key: string,
  value: number,
  userId: string,
): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  try {
    await cache.setex(key, TTL_SECONDS, String(value));
    // User index only — see the header for why the collection index is wrong here.
    const userIndex = `user:qc-keys:${userId}`;
    await cache.sadd(userIndex, key);
    await cache.expire(userIndex, TTL_SECONDS + 5);
  } catch {
    /* non-critical */
  }
}

/**
 * Whether this `as_of` may be remembered.
 *
 * A future timestamp covers revisions that do not exist yet, so its count is not
 * immutable and must be recomputed every time.
 */
export function isCacheableAsOf(asOf: Date, now: Date = new Date()): boolean {
  return asOf.getTime() < now.getTime();
}
