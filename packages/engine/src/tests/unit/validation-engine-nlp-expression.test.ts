/**
 * validation-engine.ts — nlp rule_type shares the custom expression evaluator.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

describe('validateFieldValue — nlp expression', () => {
  test('evaluates nlp rules the same way as custom rules', async () => {
    const r: ValidationRule = {
      field_name: 'score',
      rule_type: 'nlp',
      rule_config: { expression: 'value >= 10' },
      error_message: 'score too low',
    };
    expect(await validateFieldValue(5, [r])).toEqual(['score too low']);
    expect(await validateFieldValue(12, [r])).toEqual([]);
  });
});
