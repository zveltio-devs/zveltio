/**
 * There is one edge-function runner, and `EDGE_SANDBOX_MODE` no longer picks
 * another.
 *
 * The in-process Worker mode was removed rather than documented, because every
 * property that made it attractive turned out to be false when measured:
 *
 *   latency    worker 31.8 ms vs subprocess 42.6 ms per invocation — and a
 *              pre-spawned subprocess answers in 13.4 ms, so the worker was not
 *              even the fast option
 *   memory     no ceiling can be applied to a thread: Bun ignores
 *              `resourceLimits` (a worker capped at 64 MB allocated 4 GB and
 *              reported success), `smol` and BUN_JSC_forceRAMSize are GC
 *              settings, and a host-side heap reading measures the engine
 *   isolation  a runtime escape lands in the engine's address space
 *   support    Bun's own documentation calls the Worker API "still experimental
 *              (particularly for terminating workers)", and terminate() was the
 *              only way to bound a runaway there
 *
 * An operator who set the variable got an uncapped runner while believing they
 * had chosen a faster one. The variable is ignored now: whatever it says, an
 * invocation gets the subprocess, with the ceiling the kernel enforces.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { runEdgeFunction, type EdgeRequest } from '../../lib/edge-function-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
const previous = process.env.EDGE_SANDBOX_MODE;

beforeAll(() => {
  process.env.EDGE_SANDBOX_MODE = 'worker';
});
afterAll(() => {
  if (previous === undefined) delete process.env.EDGE_SANDBOX_MODE;
  else process.env.EDGE_SANDBOX_MODE = previous;
});

describe('EDGE_SANDBOX_MODE=worker no longer selects an uncapped runner', () => {
  it('refuses a runaway allocation, which only the subprocess can do', async () => {
    const code = `async function handler() {
      const held = [];
      for (let i = 0; i < 3000; i++) held.push(new Uint8Array(1048576).fill(1));
      return { status: 200, body: 'ALLOCATED ' + held.length + 'MB' };
    }`;

    const res = await runEdgeFunction(code, REQ, {}, 20_000);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/out of memory/i);
    expect(res.error).not.toMatch(/timed out/i);
  }, 30_000);

  it('still runs an ordinary function with the variable set', async () => {
    const res = await runEdgeFunction(
      'async function handler(request, env) { return { status: 201, body: { sum: 1 + 1, who: env.WHO } }; }',
      REQ,
      { WHO: 'subprocess' },
      10_000,
    );

    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(201);
    expect(res.response?.body).toEqual({ sum: 2, who: 'subprocess' });
  }, 15_000);
});
