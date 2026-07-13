/**
 * validation-engine.ts — min/max only apply to numbers.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

function rule(rule_type: string, cfg: Record<string, unknown>): ValidationRule {
  return { field_name: 'f', rule_type, rule_config: cfg, error_message: 'bad' };
}

describe('validateFieldValue — min/max type guard', () => {
  test('min does not flag non-number values', async () => {
    expect(await validateFieldValue('text', [rule('min', { value: 5 })])).toEqual([]);
    expect(await validateFieldValue(null, [rule('min', { value: 5 })])).toEqual([]);
  });

  test('max does not flag non-number values', async () => {
    expect(await validateFieldValue([], [rule('max', { value: 5 })])).toEqual([]);
    expect(await validateFieldValue(true, [rule('max', { value: 5 })])).toEqual([]);
  });
});
