/**
 * createRestrictedDb — non-query method binding + extra query entry points.
 */

import { describe, expect, it } from 'bun:test';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';

describe('createRestrictedDb — proxy forwarding', () => {
  it('binds non-query methods to the backing database', async () => {
    let transactionCalled = false;
    const db = {
      transaction() {
        transactionCalled = true;
        return { execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(db) };
      },
    };
    const rdb = createRestrictedDb(db as never, 'ext');
    await rdb.transaction().execute(async () => 'ok');
    expect(transactionCalled).toBe(true);
  });

  it('forwards replaceInto, mergeInto, and withSchema for allowed tables', () => {
    const calls: string[] = [];
    const db = {
      replaceInto(table: string) {
        calls.push(`replaceInto:${table}`);
        return db;
      },
      mergeInto(table: string) {
        calls.push(`mergeInto:${table}`);
        return db;
      },
      withSchema(schema: string) {
        calls.push(`withSchema:${schema}`);
        return db;
      },
    };
    const rdb = createRestrictedDb(db as never, 'my-ext');
    rdb.replaceInto('zvd_items' as never);
    rdb.mergeInto('zv_my_ext_meta' as never);
    rdb.withSchema('public' as never);
    expect(calls).toEqual([
      'replaceInto:zvd_items',
      'mergeInto:zv_my_ext_meta',
      'withSchema:public',
    ]);
  });
});
