/**
 * subprocess-runner.ts — stdout lines starting with "{" that are not valid JSON
 * are treated as stray logs, not the IPC envelope.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — invalid JSON prefix line', () => {
  it('ignores a malformed JSON-looking line and uses the real envelope', async () => {
    const code = `async function handler() {
      console.log('{not valid json');
      return { status: 200, body: { ok: true } };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.logs).toContain('{not valid json');
    expect((res.response?.body as { ok: boolean }).ok).toBe(true);
  }, 15_000);
});
