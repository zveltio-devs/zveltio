/**
 * validation-engine.ts — rule_config stored as a JSON string is parsed before eval.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

describe('validateFieldValue — string rule_config', () => {
  test('parses JSON-string rule_config for custom expression rules', async () => {
    const r = {
      field_name: 'qty',
      rule_type: 'custom',
      rule_config: JSON.stringify({ expression: 'value > 0' }),
      error_message: 'must be positive',
    } as unknown as ValidationRule;
    expect(await validateFieldValue(0, [r])).toEqual(['must be positive']);
    expect(await validateFieldValue(3, [r])).toEqual([]);
  });
});
