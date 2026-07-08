import { describe, expect, test } from 'bun:test';
import {
  getValidationRules,
  invalidateRulesCache,
  type ValidationRule,
  validateFieldValue,
  validateRecord,
} from '../../lib/validation-engine.js';

function rule(
  rule_type: string,
  cfg: Record<string, unknown>,
  msg: string | null = null,
): ValidationRule {
  return { field_name: 'f', rule_type, rule_config: cfg, error_message: msg };
}

// A minimal Kysely stand-in: records the field_name filter and returns the
// rows registered for it. Enough to exercise getValidationRules + validateRecord
// without a live Postgres.
// biome-ignore lint/suspicious/noExplicitAny: test double for the query builder
function fakeDb(rowsByField: Record<string, any[]>): any {
  let captured = '*';
  const qb: Record<string, unknown> = {
    select: () => qb,
    where: (col: string, _op: string, val: unknown) => {
      if (col === 'field_name') captured = String(val);
      return qb;
    },
    execute: async () => rowsByField[captured] ?? [],
  };
  return { selectFrom: () => qb };
}

describe('validateFieldValue', () => {
  test('required flags null/undefined/empty, passes non-empty', async () => {
    const rules = [rule('required', {})];
    expect(await validateFieldValue(null, rules)).toHaveLength(1);
    expect(await validateFieldValue(undefined, rules)).toHaveLength(1);
    expect(await validateFieldValue('', rules)).toHaveLength(1);
    expect(await validateFieldValue('x', rules)).toEqual([]);
  });

  test('min / max compare numbers', async () => {
    expect(await validateFieldValue(3, [rule('min', { value: 5 })])).toHaveLength(1);
    expect(await validateFieldValue(7, [rule('min', { value: 5 })])).toEqual([]);
    expect(await validateFieldValue(9, [rule('max', { value: 5 })])).toHaveLength(1);
    expect(await validateFieldValue(4, [rule('max', { value: 5 })])).toEqual([]);
  });

  test('minLength / maxLength compare string length', async () => {
    expect(await validateFieldValue('ab', [rule('minLength', { value: 3 })])).toHaveLength(1);
    expect(await validateFieldValue('abcd', [rule('minLength', { value: 3 })])).toEqual([]);
    expect(await validateFieldValue('abcd', [rule('maxLength', { value: 3 })])).toHaveLength(1);
  });

  test('range flags values outside [min,max]', async () => {
    const r = [rule('range', { min: 1, max: 10 })];
    expect(await validateFieldValue(0, r)).toHaveLength(1);
    expect(await validateFieldValue(11, r)).toHaveLength(1);
    expect(await validateFieldValue(5, r)).toEqual([]);
  });

  test('email rejects malformed, accepts a valid address and empty', async () => {
    const r = [rule('email', {})];
    expect(await validateFieldValue('not-an-email', r)).toHaveLength(1);
    expect(await validateFieldValue('a@b.co', r)).toEqual([]);
    expect(await validateFieldValue('', r)).toEqual([]); // empty is email-valid (required handles blanks)
  });

  test('url rejects malformed, accepts a valid URL', async () => {
    const r = [rule('url', {})];
    expect(await validateFieldValue('http://', r)).toHaveLength(1);
    expect(await validateFieldValue('https://example.com/x', r)).toEqual([]);
  });

  test('pattern runs the regex (Worker-guarded) and flags non-matches', async () => {
    const r = [rule('pattern', { pattern: '^[0-9]{3}$' })];
    expect(await validateFieldValue('12', r)).toHaveLength(1);
    expect(await validateFieldValue('123', r)).toEqual([]);
  });

  test('custom expression evaluates against { value } and is permissive on parse errors', async () => {
    expect(
      await validateFieldValue(5, [rule('custom', { expression: 'value > 10' })]),
    ).toHaveLength(1);
    expect(await validateFieldValue(15, [rule('custom', { expression: 'value > 10' })])).toEqual(
      [],
    );
    // Malformed expression → treated as non-violating rather than crashing.
    expect(await validateFieldValue(1, [rule('nlp', { expression: 'value >' })])).toEqual([]);
  });

  test('refuses prototype-pollution expressions without throwing or polluting', async () => {
    const before = ({} as Record<string, unknown>).polluted;
    // Crafted expressions targeting expr-eval's prototype-pollution vectors are
    // rejected (blocked token) → no violation, no throw, and Object.prototype
    // stays clean.
    for (const expr of [
      'constructor.constructor("return 1")()',
      'value.__proto__.polluted = 1',
      'value.constructor.prototype.polluted = 1',
    ]) {
      expect(await validateFieldValue('x', [rule('custom', { expression: expr })])).toEqual([]);
    }
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    // A legitimate expression still works.
    expect(
      await validateFieldValue(3, [rule('custom', { expression: 'value > 10' })]),
    ).toHaveLength(1);
  });

  test('uses the custom error_message, else a default', async () => {
    const [custom] = await validateFieldValue(null, [rule('required', {}, 'Field is required')]);
    expect(custom).toBe('Field is required');
    const [fallback] = await validateFieldValue(null, [rule('required', {})]);
    expect(fallback).toMatch(/required/);
  });

  test('accepts rule_config supplied as a JSON string', async () => {
    const r: ValidationRule = {
      field_name: 'f',
      rule_type: 'max',
      rule_config: '{"value":5}' as unknown as Record<string, unknown>,
      error_message: null,
    };
    expect(await validateFieldValue(9, [r])).toHaveLength(1);
  });
});

describe('getValidationRules + cache', () => {
  test('maps rows and caches them; invalidateRulesCache drops the entry', async () => {
    const col = `probe_${Date.now()}`;
    const db = fakeDb({
      '*': [
        { field_name: 'age', rule_type: 'min', rule_config: { value: 18 }, error_message: null },
      ],
    });
    const first = await getValidationRules(db, col);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ field_name: 'age', rule_type: 'min' });

    // Second call is served from cache even though the db would now return [].
    const emptyDb = fakeDb({ '*': [] });
    expect(await getValidationRules(emptyDb, col)).toHaveLength(1);

    invalidateRulesCache(col);
    expect(await getValidationRules(emptyDb, col)).toHaveLength(0);
  });
});

describe('validateRecord', () => {
  test('collects per-field errors and reports validity', async () => {
    const col = `rec_${Date.now()}`;
    const db = fakeDb({
      age: [
        {
          field_name: 'age',
          rule_type: 'min',
          rule_config: { value: 18 },
          error_message: 'too young',
        },
      ],
      name: [], // field with no rules → skipped
    });
    const res = await validateRecord(db, col, { age: 15, name: 'Ada' });
    expect(res.valid).toBe(false);
    expect(res.errors.age).toEqual(['too young']);
    expect(res.errors.name).toBeUndefined();

    const ok = await validateRecord(db, `${col}b`, { age: 21 });
    expect(ok.valid).toBe(true);
    expect(ok.errors).toEqual({});
  });
});
