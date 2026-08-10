/**
 * `createRestrictedDb` — an extension's `db.transaction()` joins the request's.
 *
 * Kysely refuses `transaction()` on a Transaction. Since `ctx.db` resolves the
 * request's tenant transaction per query, any extension that opened one of its
 * own hit "calling the transaction method for a Transaction is not supported".
 *
 * GDPR erasure is the case that showed it: the whole point of that route is to
 * delete a person's rows across a dozen tables atomically, so it wrapped them in
 * a transaction — and erasure therefore failed on every installation, reporting
 * "referential integrity", which named the wrong cause entirely.
 *
 * Joining is also the right semantics: the extension's work commits with the
 * request that triggered it, rather than in a second transaction that could
 * survive a rollback of the first.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';

function handle(tag: string, isTransaction: boolean) {
  return {
    tag,
    isTransaction,
    transaction() {
      return {
        setIsolationLevel() {
          return this;
        },
        setAccessMode() {
          return this;
        },
        execute<T>(cb: (t: unknown) => T) {
          return cb(`${tag}:fresh-transaction`);
        },
      };
    },
  } as unknown as Database;
}

describe('extension db.transaction()', () => {
  it('joins the request transaction instead of opening a second one', () => {
    const trx = handle('request-trx', true);
    const db = createRestrictedDb(() => trx, 'probe/join');
    const used = (
      db as unknown as { transaction(): { execute(cb: (t: unknown) => unknown): unknown } }
    )
      .transaction()
      .execute((t) => t);
    expect(used).toBe(trx);
  });

  it('accepts the builder chain an extension would write', () => {
    const trx = handle('request-trx', true);
    const db = createRestrictedDb(() => trx, 'probe/chain');
    const b = (
      db as unknown as {
        transaction(): {
          setIsolationLevel(l: string): {
            setAccessMode(m: string): { execute(cb: (t: unknown) => unknown): unknown };
          };
        };
      }
    ).transaction();
    expect(
      b
        .setIsolationLevel('serializable')
        .setAccessMode('read write')
        .execute((t) => t),
    ).toBe(trx);
  });

  it('opens a real transaction when the handle is a pool', () => {
    // Background jobs and `ctx.adminDb` have no request transaction to join, and
    // must still get a genuine one.
    const pool = handle('pool', false);
    const db = createRestrictedDb(() => pool, 'probe/pool');
    const used = (
      db as unknown as { transaction(): { execute(cb: (t: unknown) => unknown): unknown } }
    )
      .transaction()
      .execute((t) => t);
    expect(used).toBe('pool:fresh-transaction');
  });

  it('follows the resolver, so the same handle tracks the current request', () => {
    let current = handle('first', true);
    const db = createRestrictedDb(() => current, 'probe/resolver');
    const read = () =>
      (db as unknown as { transaction(): { execute(cb: (t: unknown) => unknown): unknown } })
        .transaction()
        .execute((t) => t);

    expect(read()).toBe(current);
    const second = handle('second', true);
    current = second;
    expect(read()).toBe(second);
  });
});
