/**
 * Deleting a user must end their sessions everywhere, not just in Postgres.
 *
 * The FK cascade on `session` looked like enough. When VALKEY_URL is set —
 * which is the recommended production setup — better-auth is handed a
 * `secondaryStorage` and reads sessions from THERE first, and the cascade
 * never touches it. So a deleted user's cookie kept working until the entry
 * aged out of the cache. Deactivating an account is the one moment where
 * "eventually" is the wrong answer.
 *
 * better-auth stores `active-sessions-<userId>` as a list of `{ token }` plus
 * one entry per token, so both have to go.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type Redis from 'ioredis';
import type { Database } from '../../db/index.js';
import { revokeAllUserSessions } from '../../lib/auth.js';
import { _setCacheForTests } from '../../lib/runtime/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const USER = 'u-1';

class FakeCache {
  store = new Map<string, string>();
  deleted: string[] = [];
  async get(k: string): Promise<string | null> {
    return this.store.get(k) ?? null;
  }
  async set(k: string, v: string): Promise<'OK'> {
    this.store.set(k, v);
    return 'OK';
  }
  async del(k: string): Promise<number> {
    this.deleted.push(k);
    this.store.delete(k);
    return 1;
  }
}

/** How the adapter writes it: better-auth stringifies, the adapter again. */
function doubleEncoded(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}

afterEach(() => _setCacheForTests(null));

describe('revokeAllUserSessions', () => {
  it('deletes every cached session token and the index', async () => {
    const cache = new FakeCache();
    cache.store.set(
      `active-sessions-${USER}`,
      doubleEncoded([
        { token: 'tok-a', expiresAt: Date.now() + 10_000 },
        { token: 'tok-b', expiresAt: Date.now() + 10_000 },
      ]),
    );
    cache.store.set('tok-a', 'session-a');
    cache.store.set('tok-b', 'session-b');
    _setCacheForTests(cache as unknown as Redis);

    const db = new CannedDb();
    await revokeAllUserSessions(db.kysely as unknown as Database, USER);

    expect(cache.deleted).toContain('tok-a');
    expect(cache.deleted).toContain('tok-b');
    expect(cache.deleted).toContain(`active-sessions-${USER}`);
    expect(cache.store.size).toBe(0);
  });

  it('spares the current session when asked', async () => {
    // Enabling 2FA revokes every OTHER session. Logging the user out of the tab
    // they hardened their account in would read as a failure, not protection.
    const cache = new FakeCache();
    cache.store.set(
      `active-sessions-${USER}`,
      doubleEncoded([
        { token: 'tok-current', expiresAt: Date.now() + 10_000 },
        { token: 'tok-other', expiresAt: Date.now() + 10_000 },
      ]),
    );
    cache.store.set('tok-current', 'session-current');
    cache.store.set('tok-other', 'session-other');
    _setCacheForTests(cache as unknown as Redis);

    const db = new CannedDb();
    await revokeAllUserSessions(db.kysely as unknown as Database, USER, 'tok-current');

    expect(cache.deleted).toContain('tok-other');
    expect(cache.deleted).not.toContain('tok-current');
    expect(cache.store.get('tok-current')).toBe('session-current');

    // The index is rewritten rather than dropped, or the spared session is
    // present and invisible to `listSessions`.
    const idx = cache.store.get(`active-sessions-${USER}`);
    expect(idx).toBeDefined();
    expect(idx).toContain('tok-current');
    expect(idx).not.toContain('tok-other');

    // And the DB delete excludes it.
    const sql = db.executed(/delete from "session"/i)[0];
    expect(sql?.parameters).toContain('tok-current');
  });

  it('deletes the database rows as well', async () => {
    const db = new CannedDb();
    await revokeAllUserSessions(db.kysely as unknown as Database, USER);
    const deletes = db.executed(/delete from "session"/i);
    expect(deletes.length).toBe(1);
    expect(deletes[0]?.parameters).toContain(USER);
  });

  it('works when no cache is configured', async () => {
    // Single-tenant installs without Valkey must not break.
    _setCacheForTests(null);
    const db = new CannedDb();
    expect(revokeAllUserSessions(db.kysely as unknown as Database, USER)).resolves.toBeUndefined();
  });

  it('still removes the database rows when the cache throws', async () => {
    // A purge that fails must not stop an administrator deleting an account;
    // the DB rows are what cap the exposure at the cache TTL.
    const cache = new FakeCache();
    cache.get = async () => {
      throw new Error('cache down');
    };
    _setCacheForTests(cache as unknown as Redis);
    const db = new CannedDb();
    await revokeAllUserSessions(db.kysely as unknown as Database, USER);
    expect(db.executed(/delete from "session"/i).length).toBe(1);
  });

  /**
   * The one behaviour nothing asserted, and the one that broke.
   *
   * The DELETE used to end `.catch(() => { /* table shape varies on fresh
   * installs *\/ })`. Migration 044 then took `zveltio_rls`'s grants on
   * `session` away — correctly; reading a bearer token from a tenant-scoped
   * request is what C-14 and C-10 did — and every revocation started raising
   * `permission denied`. The catch swallowed the JavaScript error and did NOT
   * un-abort the PostgreSQL transaction, so the caller's next statement failed
   * with `current transaction is aborted` and that was the only error anyone
   * saw, on a line unrelated to the cause.
   *
   * Deleting a user was broken outright. Enabling 2FA silently stopped revoking
   * anyone's other sessions — the behaviour that gives the feature its point —
   * and no test noticed, because the swallow made the failure look like success.
   *
   * A caller that cannot revoke must be told. This asserts the propagation, not
   * the message.
   */
  it('propagates a database failure instead of reporting success', async () => {
    _setCacheForTests(null);
    const db = new CannedDb();
    db.fail(/delete from "session"/i, new Error('permission denied for table session'));
    expect(revokeAllUserSessions(db.kysely as unknown as Database, USER)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('tolerates a malformed index without deleting nothing else', async () => {
    const cache = new FakeCache();
    cache.store.set(`active-sessions-${USER}`, 'not json at all');
    _setCacheForTests(cache as unknown as Redis);
    const db = new CannedDb();
    await revokeAllUserSessions(db.kysely as unknown as Database, USER);
    // The index itself is still dropped, and the DB delete still runs.
    expect(cache.deleted).toContain(`active-sessions-${USER}`);
    expect(db.executed(/delete from "session"/i).length).toBe(1);
  });
});
