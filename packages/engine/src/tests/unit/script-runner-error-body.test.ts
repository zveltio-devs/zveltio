/**
 * runScript — a runner failure that carries no response (script-runner.ts).
 *
 * The timeout is the case worth pinning: the runner answers `ok: false` with an
 * error and no `response` at all, and the logs collected before the script ran
 * out of time still have to reach the flow run. A script that hangs is the one
 * whose logs a reader most wants.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import * as subprocessRunner from '../../lib/edge-functions/subprocess-runner.js';
import { runScript } from '../../lib/script-runner.js';

describe('runScript — failure with no response', () => {
  it('returns the runner error and keeps the logs', async () => {
    const spy = spyOn(subprocessRunner, 'runEdgeFunctionInSubprocess').mockResolvedValue({
      ok: false,
      error: 'Execution timed out after 300ms',
      logs: ['still working'],
      duration_ms: 300,
    });
    try {
      const res = await runScript('return 1;');
      expect(res.output).toBeNull();
      expect(res.error).toBe('Execution timed out after 300ms');
      expect(res.logs).toContain('still working');
    } finally {
      spy.mockRestore();
    }
  });

  it('never reports success with no error when the runner fails silently', async () => {
    const spy = spyOn(subprocessRunner, 'runEdgeFunctionInSubprocess').mockResolvedValue({
      ok: false,
      logs: [],
      duration_ms: 1,
    });
    try {
      const res = await runScript('return 1;');
      expect(res.output).toBeNull();
      // A failure with no message is still a failure — reporting `error:
      // undefined` here would read as success to every caller.
      expect(res.error).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
