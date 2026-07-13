/**
 * validateFieldValue — minLength / maxLength / min / max rules (validation-engine.ts).
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

describe('validateFieldValue — length and range rules', () => {
  test('minLength flags short strings', async () => {
    const rules: ValidationRule[] = [
      {
        field_name: 'code',
        rule_type: 'minLength',
        rule_config: { value: 3 },
        error_message: 'too short',
      },
    ];
    expect(await validateFieldValue('ab', rules)).toEqual(['too short']);
    expect(await validateFieldValue('abc', rules)).toEqual([]);
  });

  test('maxLength flags long strings', async () => {
    const rules: ValidationRule[] = [
      {
        field_name: 'code',
        rule_type: 'maxLength',
        rule_config: { value: 2 },
        error_message: 'too long',
      },
    ];
    expect(await validateFieldValue('abc', rules)).toEqual(['too long']);
  });

  test('min and max flag out-of-range numbers', async () => {
    const minRule: ValidationRule[] = [
      { field_name: 'qty', rule_type: 'min', rule_config: { value: 5 }, error_message: 'too low' },
    ];
    const maxRule: ValidationRule[] = [
      {
        field_name: 'qty',
        rule_type: 'max',
        rule_config: { value: 10 },
        error_message: 'too high',
      },
    ];
    expect(await validateFieldValue(4, minRule)).toEqual(['too low']);
    expect(await validateFieldValue(11, maxRule)).toEqual(['too high']);
    expect(await validateFieldValue(7, minRule)).toEqual([]);
  });

  test('range flags values outside min/max window', async () => {
    const rules: ValidationRule[] = [
      {
        field_name: 'score',
        rule_type: 'range',
        rule_config: { min: 1, max: 5 },
        error_message: 'out of range',
      },
    ];
    expect(await validateFieldValue(0, rules)).toEqual(['out of range']);
    expect(await validateFieldValue(6, rules)).toEqual(['out of range']);
    expect(await validateFieldValue(3, rules)).toEqual([]);
  });
});
