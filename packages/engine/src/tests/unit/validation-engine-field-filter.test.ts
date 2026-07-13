/**
 * validation-engine.ts — getValidationRules fieldName filter narrows the DB query.
 */

import { describe, expect, test } from 'bun:test';
import {
  getValidationRules,
  invalidateRulesCache,
  type ValidationRule,
} from '../../lib/validation-engine.js';

// biome-ignore lint/suspicious/noExplicitAny: test double
function fakeDb(rows: ValidationRule[], calls: { sql: string[] }): any {
  const qb: Record<string, unknown> = {
    select: () => qb,
    where: (col: string, _op: string, val: unknown) => {
      calls.sql.push(`${col}=${String(val)}`);
      return qb;
    },
    execute: async () => rows,
  };
  return { selectFrom: () => qb };
}

describe('getValidationRules — fieldName filter', () => {
  test('queries only rules for the requested field when fieldName is set', async () => {
    const col = `vfield_${Date.now()}`;
    const rows: ValidationRule[] = [
      {
        field_name: 'age',
        rule_type: 'min',
        rule_config: { value: 18 },
        error_message: null,
      },
    ];
    const calls = { sql: [] as string[] };
    const db = fakeDb(rows, calls);

    const rules = await getValidationRules(db, col, 'age');
    expect(rules).toHaveLength(1);
    expect(calls.sql.some((s) => s.includes('field_name=age'))).toBe(true);

    invalidateRulesCache(col);
  });
});
