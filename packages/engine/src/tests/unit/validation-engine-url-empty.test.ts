/**
 * validation-engine.ts — url rule with empty/falsy values.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

function urlRule(): ValidationRule {
  return { field_name: 'link', rule_type: 'url', rule_config: {}, error_message: 'bad url' };
}

describe('validateFieldValue — url empty values', () => {
  test('treats null, undefined, and empty string as valid for url', async () => {
    const r = [urlRule()];
    expect(await validateFieldValue(null, r)).toEqual([]);
    expect(await validateFieldValue(undefined, r)).toEqual([]);
    expect(await validateFieldValue('', r)).toEqual([]);
  });
});
