/**
 * runScript — parsed JSON body fields (script-runner.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import * as sandbox from '../../lib/edge-functions/sandbox.js';
import { runScript } from '../../lib/script-runner.js';

describe('runScript — parsed JSON fields', () => {
  it('merges parsed.error and parsed.logs from a successful worker envelope', async () => {
    const spy = spyOn(sandbox, 'runFunction').mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        output: null,
        error: 'handler reported failure',
        logs: ['[log] from handler'],
      }),
      logs: ['worker envelope'],
      duration_ms: 12,
    });
    try {
      const res = await runScript('return 1;');
      expect(res.output).toBeNull();
      expect(res.error).toBe('handler reported failure');
      expect(res.logs).toEqual(['worker envelope', '[log] from handler']);
      expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('prefers parsed.error over a stale top-level worker error when a body is present', async () => {
    const spy = spyOn(sandbox, 'runFunction').mockResolvedValue({
      status: 500,
      body: JSON.stringify({ output: null, error: 'from json body' }),
      logs: [],
      duration_ms: 5,
      error: 'stale worker error',
    });
    try {
      const res = await runScript('return 1;');
      expect(res.error).toBe('from json body');
    } finally {
      spy.mockRestore();
    }
  });
});
