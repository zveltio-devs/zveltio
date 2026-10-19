import { describe, expect, test } from 'bun:test';
import {
  checkValidationExpression,
  evaluateExpressionRule,
  validateFieldValue,
  type ValidationRule,
} from '../../lib/validation-engine.js';

/**
 * SEC-02. The validation extension evaluated stored rules with
 * `new Function('value', 'return ' + expression)`, under a comment claiming
 * only `value` was in scope. A Function body closes over the global scope, so
 * any tenant admin who could save a validation rule could reach `process`,
 * `Bun`, and the filesystem inside the engine process.
 *
 * The engine evaluated the same rule type through expr-eval, and now through
 * CEL. These tests cover the shared function both now use, so the two cannot
 * drift back apart.
 */
describe('checkValidationExpression', () => {
  test.each([
    'process.exit(1)',
    'require("fs").readFileSync("/etc/passwd")',
    'globalThis.process.env',
    'value.constructor.constructor("return process")()',
    '__proto__.polluted = 1',
  ])('refuses to store %p', (expression) => {
    expect(checkValidationExpression(expression).ok).toBe(false);
  });

  // `process.exit(1)` is the interesting one: it PARSES. CEL reads it as a
  // method call on a variable named `process` and refuses it at evaluation
  // time, because nothing is bound to that name — so the process was never in
  // danger even without the allowlist. What the allowlist adds is that the rule cannot
  // be stored at all, instead of sitting in the database looking configured
  // while being incapable of ever evaluating.
  test('names what an unknown reference actually was', () => {
    const verdict = checkValidationExpression('process.exit(1)');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('process');
  });

  test.each([
    'value > 0',
    'value >= 10 && value <= 20',
    'size(value) > 3',
    'value > 0 ? true : false',
    'value.all(x, x > 0)',
    'value.exists(x, x.matches("^[a-z]+$"))',
  ])('accepts the legitimate rule %p', (expression) => {
    expect(checkValidationExpression(expression).ok).toBe(true);
  });
});

describe('evaluateExpressionRule', () => {
  test('passes and fails an ordinary comparison', () => {
    expect(evaluateExpressionRule('value > 0', 5)).toEqual({ status: 'passed' });
    expect(evaluateExpressionRule('value > 0', -1)).toEqual({ status: 'failed' });
  });

  // Three states, not two. A refused expression has neither passed nor failed,
  // and a rule editor that reported either would be telling its author the rule
  // works when nothing ran.
  test('reports refusal as its own outcome', () => {
    const outcome = evaluateExpressionRule('process.exit(1)', 5);
    expect(outcome.status).toBe('refused');
  });

  // The check and the evaluation are separate gates, and this is the gap
  // between them: `value.missing > 1` parses, references only `value`, and so
  // is storable — CEL refuses it only when the field is absent from the value
  // it is handed. Without this the `catch` in evaluateExpressionRule was
  // never entered, which matters because that branch is what stops a stored
  // rule from throwing into the caller's write path.
  test('refuses an expression that only fails once it runs', () => {
    expect(checkValidationExpression('value.missing > 1').ok).toBe(true);
    const outcome = evaluateExpressionRule('value.missing > 1', { other: 1 });
    expect(outcome.status).toBe('refused');
    if (outcome.status === 'refused') {
      expect(outcome.reason).toMatch(/could not be evaluated/i);
    }
  });

  test('does not execute what it refuses', () => {
    // If the old `new Function` path were still in place this would end the
    // test run rather than fail an assertion.
    expect(evaluateExpressionRule('process.exit(1)', 5).status).toBe('refused');
    expect(process.pid).toBeGreaterThan(0);
  });
});

describe('CEL specifics', () => {
  // Rules stored before the switch used expr-eval's keywords. They must be
  // refused with a pointer to the CEL spelling, not silently reinterpreted.
  test('refuses expr-eval keywords and names the CEL operators', () => {
    const verdict = checkValidationExpression('value > 1 and value < 5');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('&&');
  });

  // The column's declared type decides int versus double. Without it, a whole
  // number is a double and `value * 2` is a type error in CEL.
  test('binds a whole number as int on an integer field', () => {
    expect(evaluateExpressionRule('value * 2 > 10', 7, 'integer')).toEqual({ status: 'passed' });
    expect(evaluateExpressionRule('value * 2 > 10', '7', 'bigint')).toEqual({ status: 'passed' });
    expect(evaluateExpressionRule('value * 2 > 10', 7).status).toBe('refused');
    expect(evaluateExpressionRule('value * 2.0 > 10.0', 7.5, 'number')).toEqual({
      status: 'passed',
    });
  });

  test('refuses a result that is not a boolean', () => {
    expect(evaluateExpressionRule('value + 1', 1, 'integer').status).toBe('refused');
  });

  test('binds a missing value as null', () => {
    expect(evaluateExpressionRule('value == null', undefined)).toEqual({ status: 'passed' });
  });

  // A comprehension variable is in scope only inside its macro.
  test('scopes comprehension variables to their macro', () => {
    expect(checkValidationExpression('value.all(x, x > 0)').ok).toBe(true);
    expect(checkValidationExpression('value.all(x, x > 0) && x > 0').ok).toBe(false);
  });

  // `matches` runs RE2, which is linear-time: the classic catastrophic
  // backtracking pattern returns at once instead of stalling the write path.
  test('runs matches() on RE2, not a backtracking engine', () => {
    const started = performance.now();
    const outcome = evaluateExpressionRule('value.matches("^(a+)+$")', `${'a'.repeat(40)}!`);
    expect(outcome).toEqual({ status: 'failed' });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // Nested macros cost N^k. This one took 19 s over 300 elements with nothing
  // to stop it, blocking every request in the process; it must be cut off and
  // refused, and a refused rule refuses the write.
  test('refuses an evaluation that runs past its deadline', async () => {
    const expression = 'value.all(a, value.all(b, value.all(c, a + b + c >= 0)))';
    const value = Array.from({ length: 200 }, (_, i) => i);
    const started = performance.now();
    const outcome = evaluateExpressionRule(expression, value);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(outcome).toEqual({ status: 'refused', reason: 'took longer than 50 ms to evaluate' });
    const rule: ValidationRule = {
      field_name: 'n',
      rule_type: 'custom',
      rule_config: { expression },
      error_message: null,
    };
    expect(await validateFieldValue(value, [rule])).toHaveLength(1);
    // The interrupted interpreter is still usable.
    expect(evaluateExpressionRule('value.all(x, x >= 0)', value)).toEqual({ status: 'passed' });
  });

  test('bounds length and nesting', () => {
    expect(checkValidationExpression(`value > ${'1'.repeat(1100)}`).ok).toBe(false);
    const deep = `${'('.repeat(40)}value${')'.repeat(40)} > 1`;
    expect(checkValidationExpression(deep).ok).toBe(true); // parentheses add no nodes
    const nested = `${'value.all(x, '.repeat(20)}true${')'.repeat(20)}`;
    expect(checkValidationExpression(nested).ok).toBe(false);
  });
});
