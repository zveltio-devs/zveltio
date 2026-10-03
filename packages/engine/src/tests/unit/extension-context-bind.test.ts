/**
 * createRestrictedDb — non-query method binding.
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
});
