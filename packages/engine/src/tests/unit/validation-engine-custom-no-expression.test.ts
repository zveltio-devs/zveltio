/**
 * validation-engine.ts — a rule that cannot be evaluated refuses the write.
 *
 * An `nlp` rule with no expression and a rule type the engine does not
 * implement both used to validate nothing: the rule stayed listed as active
 * and the constraint it stood for was simply absent.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { validateFieldValue, type ValidationRule } from '../../lib/validation-engine.js';

const REFUSED = [expect.stringMatching(/cannot be evaluated/)];

describe('validateFieldValue — rules that cannot be evaluated', () => {
  let error: ReturnType<typeof spyOn>;
  beforeEach(() => {
    error = spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => error.mockRestore());

  const rule = (rule_type: string, rule_config: Record<string, unknown>): ValidationRule => ({
    id: 'r1',
    field_name: 'f',
    rule_type,
    rule_config,
    error_message: 'the author message',
  });

  test('refuses a custom rule with no expression', async () => {
    expect(await validateFieldValue(1, [rule('custom', {})])).toEqual(REFUSED);
  });

  test('refuses an nlp rule with an empty expression', async () => {
    expect(await validateFieldValue(1, [rule('nlp', { expression: '' })])).toEqual(REFUSED);
  });

  test('refuses a rule type the engine does not implement, and logs which rule', async () => {
    expect(await validateFieldValue(1, [rule('isbn', {})])).toEqual(REFUSED);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/rule r1 on f .*`isbn`/);
  });

  test('a misconfigured rule does not hide the others', async () => {
    const errors = await validateFieldValue('', [rule('isbn', {}), rule('required', {})]);
    expect(errors).toEqual([...REFUSED, 'the author message']);
  });
});
