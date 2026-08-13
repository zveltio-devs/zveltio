/**
 * validation-engine.ts — unsafe custom expression warning path.
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
  test('warns and skips violation when the expression contains a blocked token', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const errors = await validateFieldValue(5, [rule('value.constructor')]);
      expect(errors).toEqual([]);
      // Wording follows `evaluateExpressionRule`, which both this engine and
      // the validation extension now share. What is asserted is unchanged: a
      // refused expression fails nobody's write, and the operator is told the
      // rule is inert rather than left to assume it is enforcing something.
      expect(warn.mock.calls.some((c) => /refused an expression rule/.test(String(c[0])))).toBe(
        true,
      );
      expect(warn.mock.calls.some((c) => /blocked token/.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
