/**
 * subprocess-runner.ts — hard kill when the child never writes a JSON envelope.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — missing envelope', () => {
  it('returns an error when the subprocess is killed before responding', async () => {
    const code = `async function handler() {
      while (true) { await new Promise((r) => setTimeout(r, 50)); }
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 100);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no envelope|exited with code|timed out/i);
    expect(res.duration_ms).toBeGreaterThanOrEqual(100);
  }, 15_000);

  // The case above never reaches the parent's kill: the child's own timer
  // answers first. A handler that never yields starves that timer, so only the
  // parent's SIGKILL at timeoutMs + 3s stops it — before the 10s CPU ceiling.
  it('kills a handler that never yields, on the wall clock and not the CPU ceiling', async () => {
    const started = Date.now();
    const res = await runEdgeFunctionInSubprocess(
      'async function handler() { while (true) {} }',
      REQ,
      {},
      200,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Killed after the wall-clock timeout');
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);
});
