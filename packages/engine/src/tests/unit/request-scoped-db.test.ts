/**
 * `createRequestScopedDb` — the proxy that gives a request ONE pooled connection.
 *
 * Every case here is a bug that reached a running instance today, so each one is
 * pinned rather than described. The proxy is small and entirely made of edge
 * cases, which is exactly the shape of code that reads as obviously correct and
 * is not.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  createRequestScopedDb,
  getUnscopedFallbackCount,
  resetUnscopedFallbackCount,
  runWithTenantTrx,
} from '../../lib/tenancy/index.js';
import { setTenantScopedTables } from '../../lib/tenancy/tenant-context.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';

/** A stand-in for the pool: enough surface to tell it apart from a transaction. */
function fakePool(tag: string) {
  const fn = Object.assign(() => `${tag}:fn`, {
    count: () => `${tag}:count`,
    sum: () => `${tag}:sum`,
  });
  return {
    tag,
    isTransaction: false,
    fn,
    selectFrom(table: string) {
      return `${tag}:select:${table}`;
    },
    transaction() {
      return {
        setIsolationLevel() {
          return this;
        },
        setAccessMode() {
          return this;
        },
        execute<T>(cb: (t: unknown) => T) {
          return cb(`${tag}:own-transaction`);
        },
      };
    },
  } as unknown as Database;
}

function fakeTrx(tag: string) {
  const t = fakePool(tag) as unknown as { isTransaction: boolean };
  t.isTransaction = true;
  return t as unknown as Database;
}

describe('createRequestScopedDb', () => {
  it('reaches for the pool when no request transaction is open', () => {
    const db = createRequestScopedDb(fakePool('pool'));
    expect((db as unknown as { selectFrom(t: string): string }).selectFrom('zv_users')).toBe(
      'pool:select:zv_users',
    );
  });

  it('resolves the current request transaction instead of the pool', () => {
    const db = createRequestScopedDb(fakePool('pool'));
    runWithTenantTrx(fakeTrx('trx'), DEFAULT_TENANT_ID, () => {
      expect((db as unknown as { selectFrom(t: string): string }).selectFrom('zv_users')).toBe(
        'trx:select:zv_users',
      );
    });
  });

  it('goes back to the pool once the request transaction is gone', () => {
    const db = createRequestScopedDb(fakePool('pool'));
    runWithTenantTrx(fakeTrx('trx'), DEFAULT_TENANT_ID, () => {
      /* inside */
    });
    expect((db as unknown as { selectFrom(t: string): string }).selectFrom('zv_users')).toBe(
      'pool:select:zv_users',
    );
  });

  it('keeps the properties hanging off a callable object', () => {
    // `db.fn` is invocable AND carries `fn.count`, `fn.sum` and friends.
    // `Function.prototype.bind` returns a fresh function and copies none of
    // them, so the first version of this proxy turned `db.fn.count(...)` into
    // "db.fn.count is not a function" — a failure that reads as a broken route
    // and is entirely the proxy's doing. Three harness tests died on it.
    const db = createRequestScopedDb(fakePool('pool'));
    const fn = (db as unknown as { fn: (() => string) & { count(): string } }).fn;
    expect(typeof fn).toBe('function');
    expect(fn()).toBe('pool:fn');
    expect(fn.count()).toBe('pool:count');
  });

  it('joins the request transaction rather than nesting a new one', async () => {
    // Kysely refuses `transaction()` on a Transaction — "calling the transaction
    // method for a Transaction is not supported" — and nine core route files
    // open one of their own. Without this, every one of them 500s.
    const db = createRequestScopedDb(fakePool('pool'));
    const trx = fakeTrx('trx');
    await runWithTenantTrx(trx, DEFAULT_TENANT_ID, async () => {
      const joined = await (
        db as unknown as {
          transaction(): { execute(cb: (t: unknown) => unknown): unknown };
        }
      )
        .transaction()
        .execute((t) => t);
      // The request's own transaction, not a second one.
      expect(joined).toBe(trx);
    });
  });

  it('still supports the builder chain routes actually write', async () => {
    // An isolation level is checked against the running transaction, which
    // needs Postgres: harness/joined-transaction-options.test.ts.
    const db = createRequestScopedDb(fakePool('pool'));
    const trx = fakeTrx('trx');
    await runWithTenantTrx(trx, DEFAULT_TENANT_ID, async () => {
      const b = (
        db as unknown as {
          transaction(): {
            setAccessMode(m: string): { execute(cb: (t: unknown) => unknown): unknown };
          };
        }
      ).transaction();
      expect(await b.setAccessMode('read write').execute((t) => t)).toBe(trx);
    });
  });

  it('opens a real transaction when there is no request transaction to join', () => {
    const db = createRequestScopedDb(fakePool('pool'));
    const opened = (
      db as unknown as { transaction(): { execute(cb: (t: unknown) => unknown): unknown } }
    )
      .transaction()
      .execute((t) => t);
    expect(opened).toBe('pool:own-transaction');
  });
});

describe('a tenant-scoped table reached with no tenant transaction', () => {
  // The pool connects as a superuser, which bypasses RLS: a scoped table read
  // through it sees every tenant. Neither the counter nor the strict-mode throw
  // that guard against it was tested — removing either passed every test.
  it('is counted, and refused under ZVELTIO_STRICT_TENANT_SCOPE=1', () => {
    const saved = process.env.ZVELTIO_STRICT_TENANT_SCOPE;
    setTenantScopedTables(['zvd_contacts']);
    resetUnscopedFallbackCount();
    try {
      const db = createRequestScopedDb(fakePool('pool'));
      delete process.env.ZVELTIO_STRICT_TENANT_SCOPE;
      expect(db.selectFrom('zvd_contacts' as never) as unknown).toBe('pool:select:zvd_contacts');
      expect(db.selectFrom('zv_settings' as never) as unknown).toBe('pool:select:zv_settings');
      expect(getUnscopedFallbackCount()).toBe(1);

      process.env.ZVELTIO_STRICT_TENANT_SCOPE = '1';
      expect(() => db.selectFrom('zvd_contacts as c' as never)).toThrow(/tenant-scope/);
      // Inside a request transaction nothing is counted or refused.
      runWithTenantTrx(fakeTrx('trx'), DEFAULT_TENANT_ID, () => {
        expect(db.selectFrom('zvd_contacts' as never) as unknown).toBe('trx:select:zvd_contacts');
      });
    } finally {
      if (saved === undefined) delete process.env.ZVELTIO_STRICT_TENANT_SCOPE;
      else process.env.ZVELTIO_STRICT_TENANT_SCOPE = saved;
      setTenantScopedTables([]);
      resetUnscopedFallbackCount();
    }
  });
});
