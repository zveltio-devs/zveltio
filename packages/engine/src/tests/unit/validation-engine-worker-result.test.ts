/**
 * validation-engine.ts — Worker returns result:false path in safeRegexTest.
 */

import { describe, expect, test } from 'bun:test';
import { validateFieldValue } from '../../lib/validation-engine.js';

describe('safeRegexTest — Worker non-match result', () => {
  test('honours a false result from the Worker thread', async () => {
    const g = globalThis as Record<string, unknown>;
    const OriginalWorker = g.Worker;
    class FalseWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage() {
        queueMicrotask(() => {
          this.onmessage?.({ data: { result: false } } as MessageEvent);
        });
      }
      terminate() {}
    }
    g.Worker = FalseWorker;
    try {
      const errors = await validateFieldValue('nope', [
        {
          field_name: 'f',
          rule_type: 'pattern',
          rule_config: { pattern: '^yes$' },
          error_message: 'no match',
        },
      ]);
      expect(errors).toEqual(['no match']);
    } finally {
      g.Worker = OriginalWorker;
    }
  });
});
