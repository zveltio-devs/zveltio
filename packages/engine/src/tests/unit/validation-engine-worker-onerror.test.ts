/**
 * validation-engine.ts — safeRegexTest Worker onerror + invalid pattern branches.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue } from '../../lib/validation-engine.js';

describe('safeRegexTest — Worker onerror', () => {
  test('treats a Worker runtime error as a non-match', async () => {
    const g = globalThis as Record<string, unknown>;
    const OriginalWorker = g.Worker;
    class ErrorWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage() {
        queueMicrotask(() => this.onerror?.());
      }
      terminate() {}
    }
    g.Worker = ErrorWorker;
    try {
      const errors = await validateFieldValue('abc', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '^abc$' },
          error_message: 'bad pattern',
        },
      ]);
      expect(errors).toEqual(['bad pattern']);
    } finally {
      g.Worker = OriginalWorker;
    }
  });

  test('treats an invalid regex pattern as a non-match', async () => {
    const g = globalThis as Record<string, unknown>;
    const OriginalWorker = g.Worker;
    g.Worker = undefined;
    try {
      const errors = await validateFieldValue('x', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '(' },
          error_message: 'invalid regex',
        },
      ]);
      expect(errors).toEqual(['invalid regex']);
    } finally {
      g.Worker = OriginalWorker;
    }
  });
});
