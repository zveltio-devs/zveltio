import { describe, expect, test } from 'bun:test';
import { checkValidationExpression, evaluateExpressionRule } from '../../lib/validation-engine.js';

/**
 * SEC-02. The validation extension evaluated stored rules with
 * `new Function('value', 'return ' + expression)`, under a comment claiming
 * only `value` was in scope. A Function body closes over the global scope, so
 * any tenant admin who could save a validation rule could reach `process`,
 * `Bun`, and the filesystem inside the engine process.
 *
 * The engine has evaluated the same rule type through expr-eval the whole time.
 * These tests cover the shared function both now use, so the two cannot drift
 * back apart.
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

  // `process.exit(1)` is the interesting one: it PARSES. expr-eval reads it as
  // a call on a variable named `process` and refuses it at evaluation time,
  // because nothing is bound to that name — so the process was never in danger
  // even before the allowlist. What the allowlist adds is that the rule cannot
  // be stored at all, instead of sitting in the database looking configured
  // while being incapable of ever evaluating.
  test('names what an unknown reference actually was', () => {
    const verdict = checkValidationExpression('process.exit(1)');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('process');
  });

  test.each([
    'value > 0',
    'value >= 10 and value <= 20',
    'length(value) > 3',
    'if(value > 0, 1, 0)',
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
  // between them: `value(1)` parses, references only `value`, and so is
  // storable — expr-eval refuses it only when it tries to call something that
  // is not a function. Without this the `catch` in evaluateExpressionRule was
  // never entered, which matters because that branch is what stops a stored
  // rule from throwing into the caller's write path.
  test('refuses an expression that only fails once it runs', () => {
    expect(checkValidationExpression('value(1)').ok).toBe(true);
    const outcome = evaluateExpressionRule('value(1)', 5);
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
