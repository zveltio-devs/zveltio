/**
 * validation-engine.ts — string-only rules skip non-string values.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

function rule(rule_type: string, cfg: Record<string, unknown>): ValidationRule {
  return { field_name: 'f', rule_type, rule_config: cfg, error_message: 'bad' };
}

describe('validateFieldValue — string rule type guards', () => {
  test('minLength does not flag non-string values', async () => {
    expect(await validateFieldValue(123, [rule('minLength', { value: 5 })])).toEqual([]);
    expect(await validateFieldValue(null, [rule('minLength', { value: 5 })])).toEqual([]);
  });

  test('maxLength does not flag non-string values', async () => {
    expect(await validateFieldValue(false, [rule('maxLength', { value: 3 })])).toEqual([]);
  });

  test('pattern does not flag non-string values', async () => {
    expect(await validateFieldValue(42, [rule('pattern', { pattern: '^[0-9]+$' })])).toEqual([]);
  });
});
