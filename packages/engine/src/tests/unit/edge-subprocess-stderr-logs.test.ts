/**
 * subprocess-runner.ts — console.error in the child lands in envelope logs.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — child console.error', () => {
  it('includes hijacked console.error output in envelope logs', async () => {
    const code = `async function handler() {
      console.error('child error noise');
      return { status: 200, body: 'fine' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.logs?.some((l) => l.includes('[error]') && l.includes('child error noise'))).toBe(
      true,
    );
  }, 15_000);
});
