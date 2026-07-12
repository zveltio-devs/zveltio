/**
 * subprocess-runner.ts — non-JSON stdout lines are captured as extra logs.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — stray stdout', () => {
  it('merges console noise before the JSON envelope into logs', async () => {
    const code = `async function handler() {
      console.log('noise before envelope');
      return { status: 200, body: 'ok' };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.logs).toContain('noise before envelope');
    expect(res.response?.body).toBe('ok');
  });
});
