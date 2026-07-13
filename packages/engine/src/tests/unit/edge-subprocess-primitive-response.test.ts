/**
 * subprocess-runner.ts — handler returns a non-object primitive (else branch).
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — primitive handler return', () => {
  it('wraps a numeric primitive as status 200 with body set to the value', async () => {
    const code = `async function handler() { return 42; }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(200);
    expect(res.response?.body).toBe(42);
    expect(res.response?.headers ?? {}).toEqual({});
  }, 15_000);

  it('wraps a string primitive as status 200 with body set to the value', async () => {
    const code = `async function handler() { return 'hello-edge'; }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(200);
    expect(res.response?.body).toBe('hello-edge');
  }, 15_000);
});
