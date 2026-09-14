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

/**
 * `withSchema` names a SCHEMA, not a table.
 *
 * Under the old prefix denylist `withSchema('public')` passed by accident —
 * `public` does not begin `zv_` — so switching the guard to an allowlist of
 * table names would have refused a legitimate call. It gets its own rule, and
 * that rule is a boundary in its own right: an extension that can select
 * another schema is past every check below it.
 */
describe('createRestrictedDb — withSchema', () => {
  /** `makeStubDb` only records query methods; withSchema needs its own. */
  function schemaStub() {
    const seen: string[] = [];
    return {
      seen,
      db: {
        withSchema: (s: string) => {
          seen.push(s);
          return {};
        },
      },
    };
  }

  it('allows the public schema', () => {
    const { db, seen } = schemaStub();
    const rdb = createRestrictedDb(db as never, 'forms');
    rdb.withSchema('public' as never);
    expect(seen).toEqual(['public']);
  });

  it('refuses any other schema, including one that looks harmless', () => {
    const { db } = schemaStub();
    const rdb = createRestrictedDb(db as never, 'forms');
    for (const schema of ['information_schema', 'pg_catalog', 'other_tenant', 'zvd_public']) {
      expect(() => rdb.withSchema(schema as never)).toThrow(/only work in the public schema/);
    }
  });

  /**
   * `withSchema('public')` used to hand back the RAW, unwrapped query creator
   * — the guard below only checks the schema name, and nothing re-wrapped
   * what it returned. Confirmed live against a real database:
   * `ctx.db.withSchema('public').selectFrom('session')` returned the same
   * bearer token `selectFrom('session')` alone is refused for.
   */
  function schemaSelectStub() {
    const seen: string[] = [];
    return {
      seen,
      db: {
        withSchema: (_s: string) => ({
          selectFrom: (t: string) => {
            seen.push(t);
            return { execute: async () => [] };
          },
        }),
      },
    };
  }

  it('still refuses a forbidden table selected after withSchema', () => {
    const { db } = schemaSelectStub();
    const rdb = createRestrictedDb(db as never, 'forms');
    expect(() =>
      (
        rdb.withSchema('public' as never) as never as { selectFrom: (t: string) => unknown }
      ).selectFrom('session'),
    ).toThrow(/attempted to access table/);
  });

  it('still allows a permitted table selected after withSchema', () => {
    const { db, seen } = schemaSelectStub();
    const rdb = createRestrictedDb(db as never, 'forms');
    (
      rdb.withSchema('public' as never) as never as { selectFrom: (t: string) => unknown }
    ).selectFrom('zvd_contacts');
    expect(seen).toEqual(['zvd_contacts']);
  });
});

/**
 * A non-string table expression — an array of tables, or a derived-table
 * callback — used to be normalized to `''` and the permitted-check then read
 * `baseTable === ''` as "nothing named, nothing to refuse". Confirmed live:
 * `ctx.db.selectFrom(['session'])` and
 * `ctx.db.selectFrom((eb) => eb.selectFrom('session')...)` both read a real
 * bearer token through that gap. An empty/non-string table must be REFUSED,
 * not defaulted to permitted.
 */
describe('createRestrictedDb — non-string table expressions', () => {
  it('refuses an array table expression', () => {
    const { db } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'forms');
    expect(() => rdb.selectFrom(['session'] as never)).toThrow(ExtensionSecurityError);
  });

  it('refuses a derived-table callback', () => {
    const { db } = makeStubDb();
    const rdb = createRestrictedDb(db as never, 'forms');
    expect(() => rdb.selectFrom(((eb: unknown) => eb) as never)).toThrow(ExtensionSecurityError);
  });
});

/**
 * `selectFrom` and friends only checked the FROM table; a JOIN chained onto
 * the returned builder reached Postgres uninspected because join methods
 * (`innerJoin`, `leftJoin`, ...) are not in `QUERY_METHODS`. Confirmed live: a
 * permitted base table joined to `session` returned a real bearer token to an
 * extension with no capability and no grant on `session`.
 */
describe('createRestrictedDb — JOIN guard', () => {
  function makeJoinStubDb() {
    const calls: string[] = [];
    function builder(): {
      innerJoin: (t: string, ...rest: unknown[]) => unknown;
      execute: () => Promise<unknown[]>;
    } {
      return {
        innerJoin: (t: string, ...rest: unknown[]) => {
          calls.push(`innerJoin:${t}`);
          return builder();
        },
        execute: async () => [],
      };
    }
    const db = {
      selectFrom(table: string) {
        calls.push(`selectFrom:${table}`);
        return builder();
      },
    };
    return { db, calls };
  }

  it('refuses a JOIN to a table outside the allowlist', () => {
    const { db } = makeJoinStubDb();
    const rdb = createRestrictedDb(db as never, 'forms');
    const joinable = rdb.selectFrom('zvd_contacts' as never) as never as {
      innerJoin: (t: string, ...rest: unknown[]) => unknown;
    };
    expect(() => joinable.innerJoin('session', 'session.userId', 'zvd_contacts.id')).toThrow(
      /Joined tables are restricted/,
    );
  });

  it('allows a JOIN to a permitted table', () => {
    const { db, calls } = makeJoinStubDb();
    const rdb = createRestrictedDb(db as never, 'forms');
    const joinable = rdb.selectFrom('zvd_contacts' as never) as never as {
      innerJoin: (t: string, ...rest: unknown[]) => unknown;
    };
    joinable.innerJoin('zvd_orders', 'zvd_orders.contactId', 'zvd_contacts.id');
    expect(calls).toContain('innerJoin:zvd_orders');
  });
});

/**
 * A JOIN to a DERIVED table — `.leftJoin((eb) => eb.selectFrom('t')…, a, b)` —
 * names no table in the argument. The first JOIN guard read that as `''` and
 * refused, which is wrong: the subquery is ordinary SQL and `forms` has shipped
 * one over its own `zv_form_submissions` for months. Measured on 2026-09-14
 * against engine master: `forms` and `workflow/approvals` both answered 500 on
 * their main GET route, and the extensions repository's contract suite went red
 * on master with no extension change.
 *
 * The property to keep is that the INNER query cannot reach a table the
 * extension may not read — so the callback gets a guarded expression builder
 * rather than a refusal.
 */
describe('createRestrictedDb — derived-table JOIN', () => {
  function makeDerivedStubDb() {
    const calls: string[] = [];
    function eb(): { selectFrom: (t: string) => unknown } {
      return {
        selectFrom: (t: string) => {
          calls.push(`inner:${t}`);
          return eb();
        },
      };
    }
    function builder(): {
      leftJoin: (t: unknown, ...rest: unknown[]) => unknown;
      execute: () => Promise<unknown[]>;
    } {
      return {
        leftJoin: (t: unknown, ...rest: unknown[]) => {
          if (typeof t === 'function') (t as (b: unknown) => unknown)(eb());
          else calls.push(`leftJoin:${String(t)}`);
          return builder();
        },
        execute: async () => [],
      };
    }
    const db = {
      selectFrom(table: string) {
        calls.push(`selectFrom:${table}`);
        return builder();
      },
    };
    return { db, calls };
  }

  it('allows a derived table over a table the extension owns', () => {
    const { db, calls } = makeDerivedStubDb();
    const rdb = createRestrictedDb(
      db as never,
      'forms',
      new Set(['zv_forms', 'zv_form_submissions']),
    );
    const joinable = rdb.selectFrom('zv_forms' as never) as never as {
      leftJoin: (t: unknown, ...rest: unknown[]) => unknown;
    };
    joinable.leftJoin(
      (eb: never) =>
        (eb as { selectFrom: (t: string) => unknown }).selectFrom('zv_form_submissions'),
      'sc.form_id',
      'f.id',
    );
    expect(calls).toContain('inner:zv_form_submissions');
  });

  it('still refuses a table the extension may not read, from INSIDE the derived table', () => {
    const { db } = makeDerivedStubDb();
    const rdb = createRestrictedDb(
      db as never,
      'forms',
      new Set(['zv_forms', 'zv_form_submissions']),
    );
    const joinable = rdb.selectFrom('zv_forms' as never) as never as {
      leftJoin: (t: unknown, ...rest: unknown[]) => unknown;
    };
    expect(() =>
      joinable.leftJoin(
        (eb: never) => (eb as { selectFrom: (t: string) => unknown }).selectFrom('session'),
        'x',
        'y',
      ),
    ).toThrow(/inside a derived table/);
  });
});
