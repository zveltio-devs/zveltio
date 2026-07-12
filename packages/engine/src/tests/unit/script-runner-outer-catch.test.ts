/**
 * script-runner.ts — outer catch when runFunction throws unexpectedly.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import * as sandbox from '../../lib/edge-functions/sandbox.js';
import { runScript } from '../../lib/script-runner.js';

describe('runScript — outer catch', () => {
  it('returns the thrown error when runFunction rejects', async () => {
    const spy = spyOn(sandbox, 'runFunction').mockRejectedValue(new Error('sandbox blew up'));
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
