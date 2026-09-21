/**
 * Authorship is a foreign key, and an API key is not a user.
 *
 * `created_by` and `updated_by` on every collection table are
 * `TEXT REFERENCES "user"(id)`. The data path wrote `user.id` into them, which
 * for key traffic is `apikey:<uuid>` — not a row in `user`. Postgres refused
 * it with `23503 foreign_key_violation`, so no API key could create or update
 * a record at all, on any collection, whatever its scopes said. The onboarding
 * wizard hands out exactly such a key and invites the person to connect their
 * app with it.
 *
 * The principal id itself must stay `apikey:<uuid>` — RLS actors and scope
 * checks are written in those terms — so authorship, not identity, is what
 * moves: to the person who issued the key, and to NULL when that is unknown.
 */
import { describe, expect, it } from 'bun:test';
import { rowAuthorId } from '../../lib/data/auth.js';

describe('rowAuthorId', () => {
  it('records a session principal as itself', () => {
    expect(rowAuthorId({ id: 'usr_123' })).toBe('usr_123');
  });

  it('records an API key against the person who issued it', () => {
    expect(rowAuthorId({ id: 'apikey:8a7b', authorUserId: 'usr_owner' })).toBe('usr_owner');
  });

  it('records NULL — never the principal id — for a key with no known issuer', () => {
    expect(rowAuthorId({ id: 'apikey:8a7b', authorUserId: null })).toBeNull();
    expect(rowAuthorId({ id: 'apikey:8a7b' })).toBeNull();
  });

  it('never returns a value that is not a user id for key traffic', () => {
    // The regression in one line: anything starting `apikey:` reaching a
    // foreign key into `user` is a 23503 waiting for the first write.
    for (const u of [
      { id: 'apikey:1', authorUserId: 'usr_a' },
      { id: 'apikey:2', authorUserId: null },
      { id: 'apikey:3' },
    ]) {
      expect(rowAuthorId(u) ?? '').not.toContain('apikey:');
    }
  });
});
