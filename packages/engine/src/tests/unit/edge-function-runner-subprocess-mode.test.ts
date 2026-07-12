/**
 * edge-function-runner.ts — EDGE_SANDBOX_MODE=subprocess delegation.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import * as subprocess from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

let savedMode: string | undefined;

afterEach(() => {
  if (savedMode === undefined) delete process.env.EDGE_SANDBOX_MODE;
  else process.env.EDGE_SANDBOX_MODE = savedMode;
});

describe('runEdgeFunction — subprocess mode', () => {
  it('delegates to runEdgeFunctionInSubprocess when EDGE_SANDBOX_MODE=subprocess', async () => {
    savedMode = process.env.EDGE_SANDBOX_MODE;
    process.env.EDGE_SANDBOX_MODE = 'subprocess';

    const spy = spyOn(subprocess, 'runEdgeFunctionInSubprocess').mockResolvedValue({
      ok: true,
      response: { status: 202, body: { via: 'subprocess' }, headers: {} },
      logs: [],
      duration_ms: 12,
    });

    try {
      const { runEdgeFunction } = await import('../../lib/edge-function-runner.js');
      const res = await runEdgeFunction(
        'async function handler() { return { status: 200, body: "x" }; }',
        REQ,
        { WHO: 'sub' },
        5000,
      );
      expect(spy).toHaveBeenCalled();
      expect(res.ok).toBe(true);
      expect(res.response?.status).toBe(202);
      expect((res.response?.body as { via: string }).via).toBe('subprocess');
    } finally {
      spy.mockRestore();
    }
  });
});
