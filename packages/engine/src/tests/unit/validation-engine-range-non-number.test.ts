/**
 * validation-engine.ts — range rule only applies to numbers.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

describe('validateFieldValue — range type guard', () => {
  test('does not flag non-number values for range', async () => {
    const r: ValidationRule = {
      field_name: 'f',
      rule_type: 'range',
      rule_config: { min: 1, max: 10 },
      error_message: 'out of range',
    };
    expect(await validateFieldValue('5', [r])).toEqual([]);
    expect(await validateFieldValue(null, [r])).toEqual([]);
    expect(await validateFieldValue([5], [r])).toEqual([]);
  });
});
