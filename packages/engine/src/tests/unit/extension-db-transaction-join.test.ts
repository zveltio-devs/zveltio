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
 * survive a rollback of the first. The join runs inside a SAVEPOINT so a throw
 * still undoes the block — proved against Postgres in
 * `harness/extension-joined-transaction.test.ts`; these stubs cannot run one.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';

/**
 * The callback's handle is the transaction behind the same guard as `ctx.db`:
 * it reads through to the transaction but is not the transaction itself.
 * Handing over the bare one let `trx.selectFrom('session')` and raw SQL on any
 * table straight through (`harness/extension-raw-sql-allowlist.test.ts`).
 */
function expectGuarded(t: unknown, tag: string): void {
  expect((t as { tag: string }).tag).toBe(tag);
  expect(Object.keys(t as object)).toEqual([]); // the proxy, not the stub
}

type Trx = { execute(cb: (t: unknown) => unknown): unknown };
type Creator = {
  transaction(): Trx & { setIsolationLevel(l: string): { setAccessMode(m: string): Trx } };
};

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
          return cb({ tag: `${tag}:fresh-transaction` });
        },
      };
    },
  } as unknown as Database;
}

describe('extension db.transaction()', () => {
  it('joins the request transaction instead of opening a second one', async () => {
    const db = createRestrictedDb(
      () => handle('request-trx', true),
      'probe/join',
    ) as never as Creator;
    expectGuarded(await db.transaction().execute((t) => t), 'request-trx');
  });

  it('accepts the builder chain an extension would write', async () => {
    const db = createRestrictedDb(
      () => handle('request-trx', true),
      'probe/chain',
    ) as never as Creator;
    const b = db.transaction().setIsolationLevel('serializable').setAccessMode('read write');
    expectGuarded(await b.execute((t) => t), 'request-trx');
  });

  it('opens a real transaction when the handle is a pool', async () => {
    // Background jobs and `ctx.adminDb` have no request transaction to join, and
    // must still get a genuine one.
    const db = createRestrictedDb(() => handle('pool', false), 'probe/pool') as never as Creator;
    expectGuarded(await db.transaction().execute((t) => t), 'pool:fresh-transaction');
  });

  it('follows the resolver, so the same handle tracks the current request', async () => {
    let current = handle('first', true);
    const db = createRestrictedDb(() => current, 'probe/resolver') as never as Creator;
    expectGuarded(await db.transaction().execute((t) => t), 'first');
    current = handle('second', true);
    expectGuarded(await db.transaction().execute((t) => t), 'second');
  });
});
