/**
 * createRestrictedDb security policy (lib/extensions/extension-context.ts).
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

describe('createRestrictedDb — table access policy', () => {
  it('allows zvd_* user tables and non-zv tables', () => {
    const { db, selects } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'forms');
    rdb.selectFrom('zvd_contacts' as never);
    rdb.selectFrom('user' as never);
    expect(selects).toEqual(['zvd_contacts', 'user']);
  });

  it('allows the extension owned zv_<name>_ namespace', () => {
    const { db, selects } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'my-forms');
    rdb.selectFrom('zv_my_forms_config' as never);
    expect(selects).toEqual(['zv_my_forms_config']);
  });

  it('normalizes slashed extension names into the owned prefix', () => {
    const { db, selects } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'compliance/ro/saft');
    rdb.selectFrom('zv_compliance_ro_saft_exports' as never);
    expect(selects).toEqual(['zv_compliance_ro_saft_exports']);
  });

  it('allows explicitly whitelisted zv_ tables via allowedTables', () => {
    const { db, selects } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'ext', new Set(['zv_special']));
    rdb.selectFrom('zv_special' as never);
    expect(selects).toEqual(['zv_special']);
  });

  it('throws ExtensionSecurityError for foreign zv_ system tables', () => {
    const { db } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'ext');
    expect(() => rdb.selectFrom('zv_audit' as never)).toThrow(ExtensionSecurityError);
    try {
      rdb.selectFrom('zv_permissions' as never);
    } catch (err) {
      expect((err as Error).message).toContain('zv_permissions');
      expect((err as Error).message).toContain('ext');
    }
  });

  it('resolves the backing db through a function on each query', () => {
    let resolves = 0;
    const { db, selects } = makeStubDb();
    const rdb = createRestrictedDb(() => {
      resolves++;
      return db as never;
    }, 'ext');
    rdb.selectFrom('user' as never);
    rdb.selectFrom('account' as never);
    expect(resolves).toBe(2);
    expect(selects).toEqual(['user', 'account']);
  });
});
