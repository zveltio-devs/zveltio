/**
 * subprocess-runner.ts — child execution timeout and parent killTimer path.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — execution timeout', () => {
  it('returns ok:false when the handler exceeds timeoutMs', async () => {
    const code = `async function handler() {
      await new Promise((r) => setTimeout(r, 60_000));
      return { status: 200, body: 'never' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 200);
    expect(res.ok).toBe(false);
    expect(res.error ?? '').toMatch(/timed out|timeout/i);
  }, 20_000);
});
