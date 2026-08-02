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
