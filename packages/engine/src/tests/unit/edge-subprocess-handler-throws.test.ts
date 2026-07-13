/**
 * subprocess-runner.ts — handler runtime errors return ok:false with the message.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — handler throws', () => {
  it('returns ok:false when the handler throws an Error', async () => {
    const code = `async function handler() {
      throw new Error('handler runtime boom');
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('handler runtime boom');
  }, 15_000);

  it('wraps a non-object handler return as a 200 body', async () => {
    const code = `async function handler() {
      return 'plain-string-body';
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(200);
    expect(res.response?.body).toBe('plain-string-body');
  }, 15_000);
});
