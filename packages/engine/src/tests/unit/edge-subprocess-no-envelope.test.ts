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
});
