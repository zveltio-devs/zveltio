/**
 * runScript — worker error without a JSON body (script-runner.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import * as sandbox from '../../lib/edge-functions/sandbox.js';
import { runScript } from '../../lib/script-runner.js';

describe('runScript — error without body', () => {
  it('returns the worker error when runFunction reports failure with an empty body', async () => {
    const spy = spyOn(sandbox, 'runFunction').mockResolvedValue({
      status: 504,
      body: '',
      logs: ['worker timeout'],
      duration_ms: 300,
      error: 'Function timed out after 300ms',
    });
    try {
      const res = await runScript('return 1;');
      expect(res.output).toBeNull();
      expect(res.error).toBe('Function timed out after 300ms');
      expect(res.logs).toContain('worker timeout');
    } finally {
      spy.mockRestore();
    }
  });
});
