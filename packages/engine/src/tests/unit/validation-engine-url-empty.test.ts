/**
 * validation-engine.ts — url rule treats empty/falsy values as valid.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

describe('validateFieldValue — url rule empty values', () => {
  const rule: ValidationRule = {
    field_name: 'website',
    rule_type: 'url',
    rule_config: {},
    error_message: 'invalid url',
  };

  test('accepts empty string without calling URL constructor', async () => {
    expect(await validateFieldValue('', [rule])).toEqual([]);
  });

  test('accepts null and undefined', async () => {
    expect(await validateFieldValue(null, [rule])).toEqual([]);
    expect(await validateFieldValue(undefined, [rule])).toEqual([]);
  });

  test('rejects malformed non-empty urls', async () => {
    expect(await validateFieldValue('not-a-url', [rule])).toEqual(['invalid url']);
  });
});
