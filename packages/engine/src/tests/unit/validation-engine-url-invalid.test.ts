/**
 * validation-engine.ts — url rule rejects malformed URLs.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

function urlRule(): ValidationRule {
  return { field_name: 'link', rule_type: 'url', rule_config: {}, error_message: 'bad url' };
}

describe('validateFieldValue — invalid url', () => {
  test('flags non-URL strings', async () => {
    expect(await validateFieldValue('not-a-url', [urlRule()])).toEqual(['bad url']);
  });

  test('accepts well-formed http URLs', async () => {
    expect(await validateFieldValue('https://example.com/path', [urlRule()])).toEqual([]);
  });
});
