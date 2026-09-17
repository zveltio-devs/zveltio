/**
 * The contract of `ctx.internals.runEdgeFunction`, asserted against the REAL
 * implementation.
 *
 * This test exists because its absence cost a merged regression. The engine has
 * two functions called `runEdgeFunction`:
 *
 *   lib/edge-function-runner.ts   runEdgeFunction(code, EdgeRequest, env, ms)
 *                                 -> { ok, response, logs, duration_ms }
 *   lib/edge-functions/sandbox.ts runFunction(code, Request, env, ms)
 *                                 -> { status, body, logs, duration_ms, error? }
 *
 * `internals` exported the SECOND one under the first one's name. A repair to
 * `developer/edge-functions` was written against the first one's shapes, proved
 * with a probe that called the first one, and covered by a test that stubbed
 * `ctx.internals.runEdgeFunction` with the first one's shapes. Three checks, all
 * measuring the wrong function, and the extension shipped throwing
 * `request.headers.forEach is not a function` on every invocation.
 *
 * So this asserts the boundary itself: what an extension is handed must take an
 * EdgeRequest and answer a RunResult. No stub — a stub is what hid it.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';

const REQ: EdgeRequest = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  query: { q: '1' },
  body: { a: 1 },
  path: '/probe',
};

const CODE = `async function handler(request, env) {
  return { status: 201, body: { method: request.method, a: request.body?.a, who: env.WHO } };
}`;

describe('ctx.internals.runEdgeFunction — the shape extensions are handed', () => {
  it('takes an EdgeRequest and answers a RunResult', async () => {
    const internals = buildExtensionInternals();

    const result = await internals.runEdgeFunction(CODE, REQ, { WHO: 'internals' }, 5000);

    expect(result.ok).toBe(true);
    expect(result.response?.status).toBe(201);
    // The plain object has to survive the trip: a `Request` would arrive as {}.
    expect(result.response?.body).toEqual({ method: 'POST', a: 1, who: 'internals' });
    expect(Array.isArray(result.logs)).toBe(true);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports a failing handler as ok: false rather than throwing', async () => {
    const internals = buildExtensionInternals();

    const result = await internals.runEdgeFunction(
      `async function handler() { throw new Error('handler exploded'); }`,
      REQ,
      {},
      5000,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('handler exploded');
  });
});
