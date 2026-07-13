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
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('refused an unsafe expression')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
