/**
 * subprocess-runner.ts — handler response headers are forwarded.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — response headers', () => {
  it('forwards custom headers from the handler response object', async () => {
    const code = `async function handler() {
      return {
        status: 201,
        body: { ok: true },
        headers: { 'X-Custom': 'from-subprocess' },
      };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(201);
    expect(res.response?.headers?.['X-Custom']).toBe('from-subprocess');
  }, 15_000);
});
