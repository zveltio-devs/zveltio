/**
 * CPU time is bounded separately from wall-clock time.
 *
 * The wall clock was the only bound, and it is the wrong instrument on its own:
 * it punishes a function waiting on a slow HTTP call exactly as hard as one
 * spinning in a loop, so the timeout has to be generous enough for the first,
 * which makes it useless against the second. A function can burn a core for the
 * whole of its 30-second budget and be reported as a normal slow run.
 *
 * `RLIMIT_CPU` measures processor seconds actually consumed — not time spent
 * waiting — so the two limits can be set for what each is for: a short CPU
 * budget and a generous wall clock.
 *
 * The test spins for far longer than the CPU budget with a much larger
 * `timeoutMs`, so a pass can only mean the CPU limit fired: the wall clock
 * would not have reached in time.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — CPU ceiling', () => {
  it('stops a function that burns the CPU, well before its wall clock', async () => {
    const code = `async function handler() {
      const started = Date.now();
      let n = 0;
      while (Date.now() - started < 30000) { n += Math.sqrt(n + 1); }
      return { status: 200, body: n };
    }`;

    const started = Date.now();
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 30_000);
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    // The CPU budget is seconds, the wall clock here is 30s: finishing early is
    // the whole assertion. A run that took the full budget means the wall clock
    // did the work and this ceiling did nothing.
    expect(elapsed).toBeLessThan(20_000);
    expect(res.error).toMatch(/cpu/i);
  }, 45_000);

  it('leaves a function that waits rather than computes alone', async () => {
    // 3 seconds of sleeping is 3 seconds of wall clock and almost no CPU. A
    // limit that cannot tell those apart would kill this.
    const code = `async function handler() {
      await new Promise((r) => setTimeout(r, 3000));
      return { status: 200, body: 'waited' };
    }`;

    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 20_000);

    expect(res.ok).toBe(true);
    expect(res.response?.body).toBe('waited');
  }, 30_000);
});
