/**
 * validation-engine.ts — in-memory rules cache returns within TTL without re-query.
 */

import { describe, expect, test } from 'bun:test';
import {
  getValidationRules,
  invalidateRulesCache,
  type ValidationRule,
} from '../../lib/validation-engine.js';

// biome-ignore lint/suspicious/noExplicitAny: test double
function fakeDb(rows: ValidationRule[], calls: { n: number }): any {
  const qb: Record<string, unknown> = {
    select: () => qb,
    where: () => qb,
    execute: async () => {
      calls.n++;
      return rows;
    },
  };
  return { selectFrom: () => qb };
}

describe('getValidationRules — cache hit', () => {
  test('returns cached rules on a second call within the TTL', async () => {
    const col = `vcache_${Date.now()}`;
    const rows: ValidationRule[] = [
      {
        field_name: 'age',
        rule_type: 'min',
        rule_config: { value: 18 },
        error_message: null,
      },
    ];
    const calls = { n: 0 };
    const db = fakeDb(rows, calls);

    const first = await getValidationRules(db, col);
    const second = await getValidationRules(db, col);

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(calls.n).toBe(1);

    invalidateRulesCache(col);
  });
});
