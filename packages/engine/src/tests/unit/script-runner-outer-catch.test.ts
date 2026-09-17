/**
 * script-runner.ts — outer catch when the runner throws unexpectedly.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import * as subprocessRunner from '../../lib/edge-functions/subprocess-runner.js';
import { runScript } from '../../lib/script-runner.js';

describe('runScript — outer catch', () => {
  it('returns the thrown error when the runner rejects', async () => {
    const spy = spyOn(subprocessRunner, 'runEdgeFunctionInSubprocess').mockRejectedValue(
      new Error('sandbox blew up'),
    );
    try {
      const res = await runScript('return 1;');
      expect(res.output).toBeNull();
      expect(res.error).toBe('sandbox blew up');
      expect(res.logs).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
