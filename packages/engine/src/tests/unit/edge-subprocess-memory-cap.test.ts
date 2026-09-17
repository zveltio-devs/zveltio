/**
 * A runaway edge function is bounded by the kernel, not by the runtime.
 *
 * "No per-invocation memory cap" was written down here as impossible, because
 * Bun exposes no per-worker heap limit. Measuring split that claim in two:
 *
 *   node:worker_threads `resourceLimits: { maxOldGenerationSizeMb: 64 }`
 *     → the worker allocated 4 GB and reported success. Bun ignores it.
 *   a subprocess under `ulimit -v`
 *     → "Out of memory", raised as a catchable error, process alive to report it
 *
 * The subprocess runner is the default, so the default path can be capped today.
 * `Bun.spawn` cannot call setrlimit, so a shell sets the limit on itself and
 * `exec`s the interpreter — no extra process survives the call.
 *
 * The numbers here are measured, not chosen: with the cap, a function that asks
 * for 3 GB fails in ~150ms; with `EDGE_MEMORY_LIMIT_MB=0` the same function
 * allocates all 3 GB and succeeds. Below ~1 GiB of address space Bun does not
 * start at all, which is why 1024 is both the floor and the default.
 *
 * Only the capped direction is asserted. Proving the other one means letting a
 * test allocate gigabytes on whatever machine CI is having that day.
 */

import { describe, expect, it } from 'bun:test';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import { runEdgeFunctionInSubprocess } from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };

describe('runEdgeFunctionInSubprocess — memory ceiling', () => {
  it('refuses a function that allocates without bound, instead of letting it run', async () => {
    const code = `async function handler() {
      const held = [];
      for (let i = 0; i < 3000; i++) held.push(new Uint8Array(1048576).fill(1));
      return { status: 200, body: 'ALLOCATED ' + held.length + 'MB' };
    }`;

    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 20_000);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/out of memory/i);
    // The distinction that matters: this is the allocation failing, not the
    // wall-clock timeout arriving. A timeout here would mean the cap did
    // nothing and the process simply took too long to eat the machine.
    expect(res.error).not.toMatch(/timed out/i);
  }, 30_000);

  it('refuses the OTHER shape of runaway too, and names how it died', async () => {
    // Two shapes, two failure paths. An external allocation (Uint8Array, Buffer)
    // fails inside the allocator and surfaces as a catchable "Out of memory";
    // a heap-shaped one takes JSC down with it and surfaces as a signal. The
    // first version of this file asserted only the first shape, which is half a
    // control: what a flow script does when it decodes an export is the second.
    const code = `async function handler() {
      const held = [];
      for (let i = 0; i < 5000000; i++) held.push({ x: 'y'.repeat(200) });
      return { status: 200, body: held.length };
    }`;

    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 25_000);

    expect(res.ok).toBe(false);
    // Whatever the mechanism, the message must say the process was killed
    // rather than print an exit code of `null` and leave the reader guessing.
    expect(res.error).toMatch(/killed|out of memory/i);
    expect(res.error).not.toMatch(/code null/i);
  }, 40_000);

  it('leaves an ordinary function alone', async () => {
    const code = `async function handler(request, env) {
      const rows = Array.from({ length: 10000 }, (_, i) => ({ i, who: env.WHO }));
      return { status: 200, body: { count: rows.length, who: rows[0].who } };
    }`;

    const res = await runEdgeFunctionInSubprocess(code, REQ, { WHO: 'sub' }, 10_000);

    expect(res.ok).toBe(true);
    expect(res.response?.body).toEqual({ count: 10000, who: 'sub' });
  }, 15_000);
});
