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
  it('allows zvd_* user tables', () => {
    const { db, selects } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'forms');
    rdb.selectFrom('zvd_contacts' as never);
    expect(selects).toEqual(['zvd_contacts']);
  });

  /**
   * This assertion used to be `rdb.selectFrom('user')` in the test above, with
   * the title "allows zvd_* user tables AND NON-ZV TABLES", and it passed.
   *
   * The guard only ever refused a table whose name began `zv_`, and Better-Auth's
   * tables have no prefix at all. Measured through this proxy against a real
   * database, with an extension holding no capability and no grant: `session`
   * (including its `token` column, a live bearer credential), `user` and
   * `account` all read clean, while `zv_api_keys` was refused — which is exactly
   * what made the guard look like it worked.
   */
  it('refuses the unprefixed Better-Auth tables, which have no RLS', () => {
    const { db } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'forms');
    for (const table of ['user', 'session', 'account', 'verification', 'twoFactor']) {
      expect(() => rdb.selectFrom(table as never)).toThrow(/attempted to access table/);
    }
  });

  it('still refuses an engine table, and still allows one that is granted', () => {
    const { db, selects } = makeStubDb();
    expect(() =>
      createRestrictedDb(db as never, 'forms').selectFrom('zv_api_keys' as never),
    ).toThrow();
    // A grant is how an extension reaches a table the engine also declares —
    // `content/media` owns `zv_media_folders` and the engine's 001 still creates it.
    const granted = createRestrictedDb(db as never, 'forms', new Set(['zv_media_folders']));
    granted.selectFrom('zv_media_folders' as never);
    expect(selects).toEqual(['zv_media_folders']);
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
    // Permitted tables on purpose: this asserts the resolver runs per query, and
    // a refused table would never reach it.
    rdb.selectFrom('zvd_a' as never);
    rdb.selectFrom('zv_ext_b' as never);
    expect(resolves).toBe(2);
    expect(selects).toEqual(['zvd_a', 'zv_ext_b']);
  });
});
