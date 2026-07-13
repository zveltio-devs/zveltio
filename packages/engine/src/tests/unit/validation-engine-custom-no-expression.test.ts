/**
 * validation-engine.ts — custom/nlp rules without an expression are no-ops.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

describe('validateFieldValue — custom without expression', () => {
  test('skips custom rules when expression is missing', async () => {
    const r: ValidationRule = {
      field_name: 'f',
      rule_type: 'custom',
      rule_config: {},
      error_message: 'fail',
    };
    expect(await validateFieldValue(1, [r])).toEqual([]);
  });

  test('skips nlp rules when expression is missing', async () => {
    const r: ValidationRule = {
      field_name: 'f',
      rule_type: 'nlp',
      rule_config: { expression: '' },
      error_message: 'fail',
    };
    expect(await validateFieldValue(1, [r])).toEqual([]);
  });
});
