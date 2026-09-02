/**
 * Remembering `total` for `?as_of=` — the decisions, pinned.
 *
 * The count cannot be made cheaper (four formulations measured; the fastest
 * alternative saves 13% and a loose index scan is 17x worse), so it is asked
 * less often instead. That only works if the key is right about what changes
 * the answer, which is what these assert.
 */

import { describe, expect, it } from 'bun:test';
import { isCacheableAsOf, timeTravelCountKey } from '../../lib/data/time-travel-count.js';

const base = {
  tenantId: 't1',
  collection: 'orders',
  asOf: '2026-01-01T00:00:00.000Z',
  userId: 'u1',
  filters: '[]',
};

describe('what the key must separate', () => {
  it('separates tenants', () => {
    // Two firms counting the same collection at the same instant are two
    // different numbers, and the tenant is in the NAMESPACE rather than only the
    // hash so an invalidation can ever be scoped to one of them.
    expect(timeTravelCountKey(base)).not.toBe(timeTravelCountKey({ ...base, tenantId: 't2' }));
  });

  it('separates collections', () => {
    expect(timeTravelCountKey(base)).not.toBe(timeTravelCountKey({ ...base, collection: 'x' }));
  });

  it('separates instants', () => {
    expect(timeTravelCountKey(base)).not.toBe(
      timeTravelCountKey({ ...base, asOf: '2026-02-01T00:00:00.000Z' }),
    );
  });

  it('separates callers, because row rules resolve per caller', () => {
    expect(timeTravelCountKey(base)).not.toBe(timeTravelCountKey({ ...base, userId: 'u2' }));
  });

  it('separates different row rules', () => {
    const other = JSON.stringify([{ field: 'owner', condition: { op: 'eq', value: 'u1' } }]);
    expect(timeTravelCountKey(base)).not.toBe(timeTravelCountKey({ ...base, filters: other }));
  });
});

describe('what the key must NOT separate', () => {
  it('is the same across pages — that is the entire point', () => {
    // Page and limit are absent by construction: paging through one instant asks
    // the same question repeatedly, so page 2 onward must hit. A key built from
    // the request URL (as the live query cache does) would miss every page.
    expect(timeTravelCountKey(base)).toBe(timeTravelCountKey({ ...base }));
  });
});

describe('only the past may be remembered', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');

  it('remembers a past instant', () => {
    // Revisions are append-only with `created_at = now()`, so a new one always
    // falls outside a past window. The count is immutable for its key.
    expect(isCacheableAsOf(new Date('2026-05-01T00:00:00.000Z'), now)).toBe(true);
  });

  it('refuses a future one', () => {
    // A future `as_of` covers revisions that do not exist yet, so its answer can
    // still change and the immutability argument does not hold.
    expect(isCacheableAsOf(new Date('2026-07-01T00:00:00.000Z'), now)).toBe(false);
  });

  it('refuses "now" itself, which is the boundary case', () => {
    // Equal timestamps are refused rather than allowed: a revision written in
    // the same millisecond would land inside the window after it was counted.
    expect(isCacheableAsOf(now, now)).toBe(false);
  });
});
