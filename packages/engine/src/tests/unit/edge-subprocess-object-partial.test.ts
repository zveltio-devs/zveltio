/**
 * subprocess-runner.ts — handler response objects without explicit status/headers.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — partial response object', () => {
  it('defaults status to 200 and headers to {} when only body is returned', async () => {
    const code = `async function handler() {
      return { body: { only: 'body' } };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(200);
    expect(res.response?.body).toEqual({ only: 'body' });
    expect(res.response?.headers).toEqual({});
  }, 15_000);
});
