/**
 * validation-engine.ts — default error message when error_message is null.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

describe('validateFieldValue — default error message', () => {
  test('uses a generic message when error_message is null', async () => {
    const r: ValidationRule = {
      field_name: 'name',
      rule_type: 'required',
      rule_config: {},
      error_message: null,
    };
    expect(await validateFieldValue('', [r])).toEqual(['Validation failed: required']);
  });
});
