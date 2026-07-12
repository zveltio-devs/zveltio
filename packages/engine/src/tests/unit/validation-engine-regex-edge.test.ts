/**
 * validation-engine.ts — regex edge paths + field-scoped rule fetch.
 */

import { describe, expect, test } from 'bun:test';
import {
  getValidationRules,
  invalidateRulesCache,
  validateFieldValue,
} from '../../lib/validation-engine.js';

// biome-ignore lint/suspicious/noExplicitAny: test double
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

describe('validateFieldValue — regex edges', () => {
  test('invalid regex pattern is treated as non-match', async () => {
    const errors = await validateFieldValue('x', [
      { field_name: 'f', rule_type: 'pattern', rule_config: { pattern: '[' }, error_message: null },
    ]);
    expect(errors).toHaveLength(1);
  });

  test('valid patterns are evaluated via the Worker sandbox', async () => {
    const errors = await validateFieldValue('hello', [
      {
        field_name: 'f',
        rule_type: 'pattern',
        rule_config: { pattern: '^hello$' },
        error_message: null,
      },
    ]);
    expect(errors).toHaveLength(0);
  });

  test('catastrophic backtracking times out as non-match', async () => {
    const errors = await validateFieldValue(`${'a'.repeat(30)}!`, [
      {
        field_name: 'f',
        rule_type: 'pattern',
        rule_config: { pattern: '(a+)+$' },
        error_message: 'too slow',
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe('too slow');
  });

  test('falls back to direct regex test when Worker is unavailable', async () => {
    const g = globalThis as Record<string, unknown>;
    const OriginalWorker = g.Worker;
    g.Worker = undefined;
    try {
      const errors = await validateFieldValue('abc', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '^abc$' },
          error_message: null,
        },
      ]);
      expect(errors).toHaveLength(0);
    } finally {
      g.Worker = OriginalWorker;
    }
  });

  test('Worker runtime errors are treated as non-match', async () => {
    const g = globalThis as Record<string, unknown>;
    const OriginalWorker = g.Worker;
    class BrokenWorker {
      onerror: (() => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor(_url: string) {
        queueMicrotask(() => this.onerror?.());
      }
      postMessage() {}
      terminate() {}
    }
    g.Worker = BrokenWorker;
    try {
      const errors = await validateFieldValue('hello', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '^hello$' },
          error_message: 'no match',
        },
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe('no match');
    } finally {
      g.Worker = OriginalWorker;
    }
  });

  test('Worker postMessage result is used for pattern matching', async () => {
    const g = globalThis as Record<string, unknown>;
    const OriginalWorker = g.Worker;
    class MockWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage(data: { pattern: string; value: string }) {
        const matched = new RegExp(data.pattern).test(data.value);
        queueMicrotask(() => this.onmessage?.({ data: { result: matched } } as MessageEvent));
      }
      terminate() {}
    }
    g.Worker = MockWorker;
    try {
      const miss = await validateFieldValue('nope', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '^yes$' },
          error_message: 'pattern miss',
        },
      ]);
      expect(miss).toEqual(['pattern miss']);

      const hit = await validateFieldValue('yes', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '^yes$' },
          error_message: null,
        },
      ]);
      expect(hit).toEqual([]);
    } finally {
      g.Worker = OriginalWorker;
    }
  });
});

describe('getValidationRules — field filter + cache keys', () => {
  test('fetches rules for a single field and invalidates prefixed cache keys', async () => {
    const col = `vf_${Date.now()}`;
    const db = fakeDb({
      email: [
        {
          field_name: 'email',
          rule_type: 'email',
          rule_config: {},
          error_message: null,
        },
      ],
    });
    const rules = await getValidationRules(db, col, 'email');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.field_name).toBe('email');

    invalidateRulesCache(col);
    invalidateRulesCache(`${col}:email`);
    expect(await getValidationRules(fakeDb({ '*': [] }), col, 'email')).toHaveLength(0);
  });
});
