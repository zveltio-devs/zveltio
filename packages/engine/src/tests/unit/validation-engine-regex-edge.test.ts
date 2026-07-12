/**
 * validation-engine.ts — regex edge paths + field-scoped rule fetch.
 */

import { describe, expect, test } from 'bun:test';
import {
  getValidationRules,
  invalidateRulesCache,
  validateFieldValue,
} from '../../lib/validation-engine.js';

// biome-ignore lint/suspicious/noExplicitAny: test double
function fakeDb(rowsByField: Record<string, any[]>): any {
  let captured = '*';
  const qb: Record<string, unknown> = {
    select: () => qb,
    where: (col: string, _op: string, val: unknown) => {
      if (col === 'field_name') captured = String(val);
      return qb;
    },
    execute: async () => rowsByField[captured] ?? [],
  };
  return { selectFrom: () => qb };
}

describe('validateFieldValue — regex edges', () => {
  test('invalid regex pattern is treated as non-match', async () => {
    const errors = await validateFieldValue('x', [
      { field_name: 'f', rule_type: 'pattern', rule_config: { pattern: '[' }, error_message: null },
    ]);
    expect(errors).toHaveLength(1);
  });
});

describe('getValidationRules — field filter + cache keys', () => {
  test('fetches rules for a single field and invalidates prefixed cache keys', async () => {
    const col = `vf_${Date.now()}`;
    const db = fakeDb({
      email: [
        {
          field_name: 'email',
          rule_type: 'email',
          rule_config: {},
          error_message: null,
        },
      ],
    });
    const rules = await getValidationRules(db, col, 'email');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.field_name).toBe('email');

    invalidateRulesCache(col);
    invalidateRulesCache(`${col}:email`);
    expect(await getValidationRules(fakeDb({ '*': [] }), col, 'email')).toHaveLength(0);
  });
});
