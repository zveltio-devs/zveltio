/**
 * validation-engine.ts — Worker ReDoS timeout + direct-regex fallback branches.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue } from '../../lib/validation-engine.js';

describe('safeRegexTest — Worker timeout', () => {
  test('terminates a hung Worker and treats the pattern as non-match', async () => {
    const g = globalThis as Record<string, unknown>;
    const OriginalWorker = g.Worker;
    class HangingWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage() {
        /* never responds — timeout path must fire */
      }
      terminate() {}
    }
    g.Worker = HangingWorker;
    try {
      const errors = await validateFieldValue('abc', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '^abc$' },
          error_message: 'timed out',
        },
      ]);
      expect(errors).toEqual(['timed out']);
    } finally {
      g.Worker = OriginalWorker;
    }
  }, 5_000);
});

describe('safeRegexTest — direct fallback', () => {
  test('runs regex.test directly when Worker is unavailable', async () => {
    const g = globalThis as Record<string, unknown>;
    const OriginalWorker = g.Worker;
    g.Worker = undefined;
    try {
      const miss = await validateFieldValue('nope', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '^yes$' },
          error_message: 'no',
        },
      ]);
      expect(miss).toEqual(['no']);

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

  test('treats a runtime regex test throw as non-match in fallback mode', async () => {
    const g = globalThis as Record<string, unknown>;
    const OriginalWorker = g.Worker;
    const originalTest = RegExp.prototype.test;
    RegExp.prototype.test = () => {
      throw new Error('regex blew up');
    };
    g.Worker = undefined;
    try {
      const errors = await validateFieldValue('x', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '.*' },
          error_message: 'bad',
        },
      ]);
      expect(errors).toEqual(['bad']);
    } finally {
      RegExp.prototype.test = originalTest;
      g.Worker = OriginalWorker;
    }
  });
});
