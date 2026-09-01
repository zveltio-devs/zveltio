/**
 * Every applier reads the shared table — asserted, not assumed.
 *
 * `rule-operators.ts` exists so a change to what an operator means is one edit
 * instead of four. That is only true if all four appliers actually read it, and
 * "I refactored them to" is exactly the kind of claim that rots: a leftover
 * hard-coded `'<>'` is invisible while it happens to match the table.
 *
 * So each case below derives its expectation FROM the table. Change a spelling
 * there and these follow; leave a literal behind in an applier and they fail.
 *
 * This is the structural half of the guarantee. The differential suite
 * (row-rules-four-interpreters) is the behavioural half: it catches the four
 * disagreeing, which is what happened seven times, and then eighteen more.
 */

import { describe, expect, it } from 'bun:test';
import { Kysely, PostgresDialect } from 'kysely';
import { buildRowRulePredicate } from '../../lib/tenancy/row-rule-policy.js';
import { applyRlsFilters, matchesRlsFilters, rlsJsonConditions } from '../../lib/tenancy/rls.js';
import { RULE_OPERATORS, type RuleOperator } from '../../lib/tenancy/rule-operators.js';

const OPS = Object.keys(RULE_OPERATORS) as RuleOperator[];

// Never connected: `.compile()` renders SQL without touching the pool.
// No `biome-ignore` here: `noExplicitAny` does not fire in test files, so one
// would be an unused suppression — which this repo ratchets, and which a gate
// caught before CI did.
const kysely = new Kysely<Record<string, never>>({
  dialect: new PostgresDialect({ pool: {} as never }),
});
const TYPES = { bucket: 'text' };

/** A recording stand-in for a Kysely query builder. */
function recorder() {
  const calls: Array<{ field: string; op: string; value: unknown }> = [];
  const chain = {
    calls,
    where(field: string, op: string, value: unknown) {
      calls.push({ field, op, value });
      return chain;
    },
  };
  return chain;
}

describe('the four appliers read one table', () => {
  it('the live-table WHERE uses the Kysely spelling from the table', () => {
    for (const op of OPS) {
      const rec = recorder();
      applyRlsFilters(rec, [{ field: 'bucket', condition: { op, value: 'x' } as never }]);
      expect(rec.calls[0]?.op).toBe(RULE_OPERATORS[op].kysely);
    }
  });

  it('the generated policy uses the SQL spelling from the table', () => {
    for (const op of OPS) {
      const { predicate } = buildRowRulePredicate(
        [
          {
            role: '*',
            filter_field: 'bucket',
            filter_op: op,
            filter_value_source: 'static:alpha',
          },
        ],
        TYPES,
      );
      expect(predicate).toContain(`"bucket" ${RULE_OPERATORS[op].sql}`);
    }
  });

  it('the jsonb path uses the SQL spelling from the table', () => {
    for (const op of OPS) {
      const [frag] = rlsJsonConditions([
        { field: 'bucket', condition: { op, value: 'x' } as never },
      ]);
      // Compiled through a real Kysely, which never opens a connection for
      // `.compile()`. Compiling is what proves the spelling reached the
      // statement, rather than a template that merely mentions it.
      const compiled = kysely
        .selectFrom('zvd_probe' as never)
        .select('id' as never)
        .where(frag as never)
        .compile();
      expect(compiled.sql).toContain(RULE_OPERATORS[op].sql);
    }
  });

  it('the in-memory evaluator agrees with the table, case for case', () => {
    for (const op of OPS) {
      for (const [value, condition] of [
        ['alpha', 'alpha'],
        ['beta', 'alpha'],
        ['5', 5],
      ] as Array<[string, unknown]>) {
        const viaTable = RULE_OPERATORS[op].keep(value, condition);
        const viaApplier = matchesRlsFilters({ bucket: value }, [
          { field: 'bucket', condition: { op, value: condition } as never },
        ]);
        expect({ op, value, condition, viaApplier }).toEqual({
          op,
          value,
          condition,
          viaApplier: viaTable,
        });
      }
    }
  });

  it('a missing value drops the row on every operator, negatives included', () => {
    // The audit's finding, in the one place it now lives. `NULL <> 'x'` is NULL,
    // not TRUE, so SQL discards such a row — and in-memory code that reasons
    // `undefined !== 'x'` keeps it. That disagreement was a leak.
    for (const op of OPS) {
      for (const missing of [null, undefined]) {
        expect(
          matchesRlsFilters({ bucket: missing }, [
            { field: 'bucket', condition: { op, value: 'alpha' } as never },
          ]),
        ).toBe(false);
      }
    }
  });

  it('refuses an operator the table does not know, in every applier', () => {
    const bad = { field: 'bucket', condition: { op: 'regex', value: 'x' } as never };
    expect(() => applyRlsFilters(recorder(), [bad])).toThrow(/cannot apply/);
    expect(() => matchesRlsFilters({ bucket: 'a' }, [bad])).toThrow(/cannot apply/);
    expect(() => rlsJsonConditions([bad])).toThrow(/cannot apply/);
    // The policy generator reports rather than throws: it runs over every stored
    // rule at once, and one bad rule must not stop the others being enforced.
    const { predicate, skipped } = buildRowRulePredicate(
      [
        {
          role: '*',
          filter_field: 'bucket',
          filter_op: 'regex',
          filter_value_source: 'static:alpha',
        },
      ],
      TYPES,
    );
    expect(predicate).toBeNull();
    expect(skipped[0]?.reason).toContain('regex');
  });
});
