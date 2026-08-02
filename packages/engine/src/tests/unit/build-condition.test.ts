/**
 * `buildCondition` — one filter condition to SQL.
 *
 * Exported because the cursor-pagination branch of the list handler used to
 * re-implement a subset of it: the six comparison operators, with `in` and
 * `not_in` falling through the `else if` chain unnoticed. Those are valid RLS
 * operators and RLS conditions share the same filter map, so a row policy
 * written with `in` stopped applying the moment a caller added `?cursor=`. The
 * policy did not fail — it was simply absent.
 *
 * The compiled SQL is asserted rather than the row results, because what went
 * wrong was a clause never being emitted at all.
 */

import { describe, expect, it } from 'bun:test';
import { buildCondition } from '../../db/dynamic.js';
import { CannedDb } from './fixtures/canned-db.js';

/** Compile a condition by running a query that carries it. */
function compile(field: string, cond: Parameters<typeof buildCondition>[1]): string {
  const db = new CannedDb();
  // Narrow shape rather than `any`: the table is resolved at runtime, which is
  // the only reason Kysely's typed API cannot name it.
  const kysely = db.kysely as unknown as {
    selectFrom(t: string): {
      selectAll(): { where(e: unknown): { compile(): { sql: string } } };
    };
  };
  return kysely.selectFrom('zvd_things').selectAll().where(buildCondition(field, cond)).compile()
    .sql;
}

describe('buildCondition', () => {
  it('emits the comparison operators', () => {
    expect(compile('n', { op: 'eq', value: 1 })).toMatch(/"n" = /);
    expect(compile('n', { op: 'neq', value: 1 })).toMatch(/"n" != /);
    expect(compile('n', { op: 'lt', value: 1 })).toMatch(/"n" < /);
    expect(compile('n', { op: 'lte', value: 1 })).toMatch(/"n" <= /);
    expect(compile('n', { op: 'gt', value: 1 })).toMatch(/"n" > /);
    expect(compile('n', { op: 'gte', value: 1 })).toMatch(/"n" >= /);
  });

  it('emits the set operators the cursor branch used to drop', () => {
    // `routes/rls.ts` accepts exactly eq | neq | in | not_in, so these two are
    // half of what a row policy can say.
    expect(compile('tag', { op: 'in', value: ['a', 'b'] })).toMatch(/"tag" = ANY/);
    expect(compile('tag', { op: 'not_in', value: ['a', 'b'] })).toMatch(/NOT \("tag" = ANY/);
  });

  it('emits the null and pattern operators', () => {
    expect(compile('c', { op: 'null' })).toMatch(/"c" IS NULL/);
    expect(compile('c', { op: 'not_null' })).toMatch(/"c" IS NOT NULL/);
    expect(compile('c', { op: 'like', value: 'x' })).toMatch(/"c" LIKE /);
    expect(compile('c', { op: 'ilike', value: 'x' })).toMatch(/"c" ILIKE /);
  });

  it('refuses an operator it does not know instead of guessing equality', () => {
    // The old default returned `col = value`, so an unrecognised operator
    // quietly became equality — which turns a restrictive condition into a
    // permissive one, and does it on the untyped path (a policy row read from
    // the database) where it is least likely to be noticed.
    expect(() => compile('c', { op: 'starts_with' as never, value: 'x' })).toThrow(
      /Unsupported filter operator/,
    );
  });
});
