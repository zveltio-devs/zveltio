/**
 * Pre-spawned runners: pay the process startup before the request, not during.
 *
 * A process per invocation is what makes the ceilings enforceable, and its cost
 * is startup. Measured with the real bootstrap, median of 12:
 *
 *   spawned on demand : 41.6 ms
 *   already waiting   : 13.4 ms
 *
 * So the pool does not change what runs or how it is bounded — one process,
 * one invocation, killed after. It changes WHEN the interpreter boots.
 *
 * The properties worth pinning are the ones that break quietly: a taken runner
 * must be replaced, a runner must never serve twice, an empty pool must still
 * answer, and nothing may survive shutdown. The last is the one that leaves
 * orphans on a developer's machine for a week.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import {
  __poolStatsForTests,
  drainRunnerPool,
  runEdgeFunctionInSubprocess,
} from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
const CODE = 'async function handler(request, env) { return { status: 200, body: env.N }; }';

afterEach(async () => {
  await drainRunnerPool();
});

describe('the runner pool', () => {
  it('serves a correct answer whether or not a runner was waiting', async () => {
    // Cold: nothing pre-spawned yet.
    const cold = await runEdgeFunctionInSubprocess(CODE, REQ, { N: 'cold' }, 10_000);
    expect(cold.ok).toBe(true);
    expect(cold.response?.body).toBe('cold');

    // Warm: the first call left a replacement behind.
    const warm = await runEdgeFunctionInSubprocess(CODE, REQ, { N: 'warm' }, 10_000);
    expect(warm.ok).toBe(true);
    expect(warm.response?.body).toBe('warm');
  }, 30_000);

  it('replaces a runner it hands out, so the next call finds one waiting', async () => {
    await runEdgeFunctionInSubprocess(CODE, REQ, { N: '1' }, 10_000);
    // Give the replacement a moment to boot — it is spawned without being
    // awaited, precisely so the request does not pay for it.
    await Bun.sleep(400);

    expect(__poolStatsForTests().idle).toBeGreaterThan(0);
  }, 30_000);

  it('never serves one runner twice', async () => {
    await runEdgeFunctionInSubprocess(CODE, REQ, { N: 'a' }, 10_000);
    await Bun.sleep(400);
    const before = __poolStatsForTests().servedPids;

    await runEdgeFunctionInSubprocess(CODE, REQ, { N: 'b' }, 10_000);
    const after = __poolStatsForTests().servedPids;

    expect(after.length).toBe(before.length + 1);
    // A reused process would mean the second invocation inherited the first
    // one's globals — the isolation this runner exists for.
    expect(new Set(after).size).toBe(after.length);
  }, 30_000);

  it('leaves nothing running after a drain', async () => {
    await runEdgeFunctionInSubprocess(CODE, REQ, { N: 'x' }, 10_000);
    await Bun.sleep(400);
    expect(__poolStatsForTests().idle).toBeGreaterThan(0);

    await drainRunnerPool();

    expect(__poolStatsForTests().idle).toBe(0);
  }, 30_000);
});
