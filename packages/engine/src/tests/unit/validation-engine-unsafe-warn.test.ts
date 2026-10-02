/**
 * validation-engine.ts — a refused expression refuses the write.
 */
import { describe, expect, test, spyOn } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

function rule(expression: string): ValidationRule {
  return {
    field_name: 'score',
    rule_type: 'custom',
    rule_config: { expression },
    error_message: 'failed custom',
  };
}

describe('validateFieldValue — unsafe expression guard', () => {
  test('refuses the write and logs why when the expression contains a blocked token', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const errors = await validateFieldValue(5, [rule('value.constructor')]);
      // The caller learns the rule is broken, not what the rule says.
      expect(errors).toEqual([expect.stringMatching(/cannot be evaluated/)]);
      expect(errors[0]).not.toMatch(/constructor|blocked/);
      // The operator learns why.
      expect(error.mock.calls.some((c) => /blocked token/.test(String(c[0])))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});
