/**
 * HMAC-signed cache entries.
 *
 * The `rls:policies:*` and `colperms:*` caches were stored as plain JSON while
 * both decide what a request is allowed to see: replacing the first with `[]`
 * drops every row filter, replacing the second with empty sets un-hides every
 * hidden column. Neither needs a login to exploit, only write access to the
 * cache, and both fail quietly — the request succeeds and returns more than it
 * should.
 *
 * These cases pin the properties that make signing worth having: a rewritten
 * value is refused, and so is a valid value moved to a different key.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { decodeSigned, encodeSigned } from '../../lib/tenancy/signed-cache.js';

const POLICIES = [{ id: 'p1', collection: 'salaries', role: 'employee', filter_field: 'user_id' }];

describe('signed cache', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'test-secret-for-signing';
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previous;
  });

  it('round-trips a value', () => {
    const raw = encodeSigned('rls', 'rls:policies:salaries', POLICIES);
    expect(decodeSigned<typeof POLICIES>('rls', 'rls:policies:salaries', raw)).toEqual(POLICIES);
  });

  it('refuses a value someone rewrote', () => {
    // The attack: empty the policy list so no row filter is applied.
    const raw = encodeSigned('rls', 'rls:policies:salaries', POLICIES);
    const forged = `${raw.slice(0, raw.indexOf(':'))}:[]`;
    expect(decodeSigned('rls', 'rls:policies:salaries', forged)).toBeNull();
  });

  it('refuses a value signed for a different key', () => {
    // Otherwise a permissive collection's entry could be copied over a
    // restricted one — a valid signature for the wrong question.
    const raw = encodeSigned('rls', 'rls:policies:public_notes', []);
    expect(decodeSigned('rls', 'rls:policies:salaries', raw)).toBeNull();
  });

  it('refuses a value signed under a different namespace', () => {
    const raw = encodeSigned('colperms', 'k', { hidden: [], readOnly: [] });
    expect(decodeSigned('rls', 'k', raw)).toBeNull();
  });

  it('refuses unsigned and malformed entries', () => {
    // Anything written by an older build, or by hand.
    expect(decodeSigned('rls', 'k', JSON.stringify(POLICIES))).toBeNull();
    expect(decodeSigned('rls', 'k', '')).toBeNull();
    expect(decodeSigned('rls', 'k', 'deadbeef:not json')).toBeNull();
  });

  it('treats a correctly signed but unparseable value as a miss', () => {
    // `JSON.stringify(undefined)` is `undefined`, so caching an absent value
    // stores the literal text "undefined" under a VALID signature. Parsing it
    // throws, and the caller must get a miss rather than a 500.
    const raw = encodeSigned('rls', 'k', undefined);
    expect(decodeSigned('rls', 'k', raw)).toBeNull();
  });

  it('refuses a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the guard must come first.
    expect(decodeSigned('rls', 'k', 'ab:[]')).toBeNull();
  });

  it('will not sign without a secret', () => {
    // An empty key is not a signature. Better to fail at startup than to
    // provide integrity theatre.
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => encodeSigned('rls', 'k', [])).toThrow(/BETTER_AUTH_SECRET/);
  });
});
