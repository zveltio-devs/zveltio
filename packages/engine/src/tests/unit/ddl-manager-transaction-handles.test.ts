/**
 * DDLManager and the handle it is given.
 *
 * Two rules pull in opposite directions, and both were arrived at by something
 * failing in production.
 *
 * `withLockTimeout` used to open its own transaction unconditionally. Three of
 * the five DDL queue handlers hand it a transaction handle, and Kysely refuses a
 * nested `.transaction()` outright — "calling the transaction method for a
 * Transaction is not supported" — so those handlers threw before emitting a
 * single statement. It short-circuits on `isTransaction` now; `SET LOCAL` is
 * transaction-scoped either way, so the caller's transaction gets the timeout it
 * asked for.
 *
 * `applyRelationFK` is the opposite: it issues `CREATE INDEX CONCURRENTLY`,
 * which PostgreSQL refuses inside a transaction block (SQLSTATE 25001). Given a
 * transaction handle it must refuse with a message that says which, rather than
 * emit DDL that the server will reject halfway through.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

/**
 * A handle that claims to be a transaction, the way Kysely's `Transaction` does.
 *
 * Defined on the instance rather than wrapped in a Proxy: Kysely reads
 * `this.#props` internally, and a private field does not survive a Proxy — the
 * first real query throws "Cannot access invalid private field" instead of
 * exercising the branch under test.
 */
function asTransaction(db: CannedDb): Database {
  const k = db.kysely as unknown as object;
  // `isTransaction` is a readonly getter on the prototype; an own data property
  // shadows it without touching the instance's internals.
  Object.defineProperty(k, 'isTransaction', { value: true, configurable: true });
  return k as unknown as Database;
}

describe('DDLManager — transaction handles', () => {
  it('applyRelationFK refuses a transaction handle, naming CREATE INDEX CONCURRENTLY', async () => {
    const db = new CannedDb();
    await expect(
      DDLManager.applyRelationFK(asTransaction(db), 'zvd_orders', 'customer_id', 'zvd_customers'),
    ).rejects.toThrow(/CREATE INDEX CONCURRENTLY/);

    // And it refused before emitting anything, rather than part-way through.
    expect(db.executed(/CREATE INDEX/i)).toHaveLength(0);
    expect(db.executed(/ALTER TABLE/i)).toHaveLength(0);
  });

  it('applyRelationFK names the SQLSTATE, so the message is searchable', async () => {
    const db = new CannedDb();
    await expect(
      DDLManager.applyRelationFK(asTransaction(db), 'zvd_orders', 'customer_id', 'zvd_customers'),
    ).rejects.toThrow(/25001/);
  });
  it('withLockTimeout does NOT open a transaction when handed one', async () => {
    // Kysely refuses a nested `.transaction()` outright — "calling the transaction
    // method for a Transaction is not supported" — and three of the five DDL queue
    // handlers pass a transaction handle in. Those handlers threw before emitting
    // a single statement.
    const db = new CannedDb();
    await DDLManager.dropJunctionTable(asTransaction(db), 'zvd_jnc_orders_tags');

    // The work still happened, on the caller's transaction.
    expect(db.executed(/DROP TABLE IF EXISTS "zvd_jnc_orders_tags"/i).length).toBeGreaterThan(0);
    // And the timeout was still applied — `SET LOCAL` is transaction-scoped either
    // way, so the caller's transaction gets what it asked for.
    expect(db.executed(/SET LOCAL lock_timeout/i).length).toBeGreaterThan(0);
  });

  it('still validates the junction name before any of that', async () => {
    const db = new CannedDb();
    await expect(
      DDLManager.dropJunctionTable(asTransaction(db), 'zvd_orders; DROP DATABASE x'),
    ).rejects.toThrow(/Invalid junction table name/);
    expect(db.executed(/DROP/i)).toHaveLength(0);
  });
});
