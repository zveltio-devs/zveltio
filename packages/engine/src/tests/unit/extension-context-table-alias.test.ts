/**
 * createRestrictedDb — zv_ system table alias stripping (extension-context.ts).
 */

import { describe, expect, it } from 'bun:test';
import {
  createRestrictedDb,
  ExtensionSecurityError,
} from '../../lib/extensions/extension-context.js';

function makeStubDb() {
  const selects: string[] = [];
  const db = {
    selectFrom(table: string) {
      selects.push(table);
      return db;
    },
    execute: async () => [],
  };
  return { db, selects };
}

describe('createRestrictedDb — aliased zv_ tables', () => {
  it('blocks system tables even when passed with an SQL alias', () => {
    const { db } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'my-ext');
    expect(() => rdb.selectFrom('zv_tenants as t' as never)).toThrow(ExtensionSecurityError);
    try {
      rdb.selectFrom('zv_users as u' as never);
    } catch (err) {
      expect((err as Error).message).toContain('zv_users');
      expect((err as Error).message).toContain('my-ext');
    }
  });
});
