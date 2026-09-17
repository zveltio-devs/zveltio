/**
 * `EDGE_SANDBOX_MODE=worker` must not mean "no SSRF guard".
 *
 * The worker runner handed user code the parent's raw `fetch`, with a comment
 * explaining why: safeFetch is not importable from inside a `data:` URL Worker.
 * That was true of the module and false of the guard — the source can be
 * generated into the bootstrap, which is what the subprocess runner had been
 * doing all along.
 *
 * So an operator who switched to worker mode for latency also, silently, turned
 * off the SSRF protection: an edge function could read cloud instance metadata
 * and reach anything on the host's private network. Both modes refuse now.
 *
 * What is still different, and deliberately so: the worker bootstrap has no
 * resolver it may use after lockdown, so it checks the literal host only, while
 * the subprocess resolves the name and checks every address. Literal-IP cases
 * are the ones asserted here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { runEdgeFunction, type EdgeRequest } from '../../lib/edge-function-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
const previousMode = process.env.EDGE_SANDBOX_MODE;

beforeAll(() => {
  process.env.EDGE_SANDBOX_MODE = 'worker';
});
afterAll(() => {
  if (previousMode === undefined) delete process.env.EDGE_SANDBOX_MODE;
  else process.env.EDGE_SANDBOX_MODE = previousMode;
});

async function fetchFromWorker(target: string) {
  const code = `async function handler() {
    try {
      const res = await fetch(${JSON.stringify(target)});
      return { status: 200, body: 'FETCHED ' + res.status };
    } catch (e) {
      return { status: 200, body: 'threw: ' + e.message };
    }
  }`;
  const res = await runEdgeFunction(code, REQ, {}, 4000);
  return String(res.response?.body ?? res.error ?? '');
}

describe('worker-mode edge functions are SSRF-guarded', () => {
  it('blocks cloud instance metadata', async () => {
    expect(await fetchFromWorker('http://169.254.169.254/latest/meta-data/')).toContain('blocked');
  });

  it("blocks Oracle Cloud's metadata address", async () => {
    expect(await fetchFromWorker('http://192.0.0.192/')).toContain('blocked');
  });

  it('blocks loopback, where the engine keeps its own database', async () => {
    expect(await fetchFromWorker('http://127.0.0.1:5432/')).toContain('blocked');
  });

  it('still runs an ordinary handler, so the guard did not break the runner', async () => {
    const res = await runEdgeFunction(
      'async function handler(request, env) { return { status: 201, body: { sum: 1 + 1, who: env.WHO } }; }',
      REQ,
      { WHO: 'worker' },
      4000,
    );
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(201);
    expect(res.response?.body).toEqual({ sum: 2, who: 'worker' });
  });
});
