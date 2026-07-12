/**
 * ai_decision — provider without chat() uses fallback (flow-executor.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _internalForTests } from '../../lib/flows/flow-executor.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { CannedDb } from './fixtures/canned-db.js';

const { executeStep } = _internalForTests;

afterEach(() => {
  serviceRegistry.unregisterAll('test');
});

describe('executeStep — ai_decision no chat provider', () => {
  it('falls back when ai.providers exists but getDefault has no chat()', async () => {
    serviceRegistry.registerAs('test', 'ai.providers', {
      getDefault: () => ({}),
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { output } = await executeStep(
        new CannedDb().kysely as unknown as Database,
        {
          type: 'ai_decision',
          config: {
            prompt: 'Pick one',
            options: ['yes', 'no'],
            fallback: 'no',
          },
        },
        {},
        {},
      );
      expect(output.decision).toBe('no');
      expect(output.usedFallback).toBe(true);
      expect(output.error).toBe('No AI provider');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('no AI provider'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
