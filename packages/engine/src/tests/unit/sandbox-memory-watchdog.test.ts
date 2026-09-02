/**
 * edge-functions/sandbox.ts — the host's own heap must not end an invocation.
 *
 * This file used to assert the opposite. It mocked `process.memoryUsage()` to
 * report a large heap and expected `runFunction` to answer 507 "Function
 * exceeded memory limit", pinning a watchdog that compared the HOST thread's
 * heap against a per-worker threshold.
 *
 * That guard could not do its job, and the mock is why the gap stayed invisible:
 * a fake number made it look like it was watching the function. Measured on the
 * real runtime instead:
 *
 *     worker allocates ~200 MB      →  host heap grows 0 MB
 *     worker returns a 400 MB body  →  host heap grows 0 MB
 *
 * It never observed the function at all. What it observed was everything else
 * the engine had allocated, so on a busy engine a function that allocated
 * nothing was killed and told it had used the server's memory.
 *
 * It reached CI as a test that failed only inside the full suite and never
 * alone — `enforces the execution timeout with a 504` returning 507 instead,
 * because 487 test files had filled the heap first. Reproduced exactly: clean
 * heap → 504; the same fixture with 376 MB of unrelated ballast → 507.
 *
 * So the watchdog is gone, and these tests hold the line that replaced it: the
 * host's memory is not the caller's business, and a runaway function is still
 * bounded — by the timeout, and by the worker dying of its own OOM.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { runFunction } from '../../lib/edge-functions/sandbox.js';

const OriginalWorker = globalThis.Worker;
/** Comfortably past what the removed watchdog used as its ceiling. */
const HUGE_HOST_HEAP = 64 * 1024 * 1024 * 8;

/**
 * Restore `process.memoryUsage` too, not just the Worker.
 *
 * The version of this file that these tests replaced spied on it and never put
 * it back, so every later file in the same run saw a fabricated 256 MB heap.
 * That is its own quiet hazard — and a fitting one, given what the spy was
 * hiding here.
 */
const spies: { mockRestore: () => void }[] = [];

afterEach(() => {
  globalThis.Worker = OriginalWorker;
  for (const s of spies.splice(0)) s.mockRestore();
});

function fakeHostHeap(bytes: number): void {
  spies.push(
    spyOn(process, 'memoryUsage').mockReturnValue({
      heapUsed: bytes,
      heapTotal: bytes,
      rss: bytes,
      external: 0,
      arrayBuffers: 0,
    } as unknown as NodeJS.MemoryUsage),
  );
}

const req = () => new Request('https://fn.local/run');

describe('runFunction — the host heap is not the function', () => {
  it('a huge host heap does not turn a timeout into a memory error', async () => {
    // The exact shape of the CI flake: a busy process, and a function whose only
    // fault is running too long. It must still be reported as too long.
    fakeHostHeap(HUGE_HOST_HEAP);

    const res = await runFunction('async function handler() { while (true) {} }', req(), {}, 300);

    expect(res.status).toBe(504);
    expect(res.error).toMatch(/timed out/i);
  });

  it('a huge host heap does not stop a function that would have succeeded', async () => {
    fakeHostHeap(HUGE_HOST_HEAP);

    const res = await runFunction(
      'async function handler() { return new Response("ok"); }',
      req(),
      {},
      5000,
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
  });

  /**
   * The third case — a function that allocates without bound — is deliberately
   * NOT asserted here.
   *
   * It was, briefly, and it took six other tests down with it: the fixture
   * consumes real memory until the worker dies, and the `runEdgeFunctionInSubprocess`
   * suite that runs after it could no longer spawn. A test that destabilises the
   * run it lives in is worse than the coverage it buys.
   *
   * The behaviour is real and was measured by hand on this runtime — an
   * unbounded allocator returns 500 "Out of memory", which is what makes
   * removing the watchdog safe rather than merely tidy. It belongs in a
   * resource-isolated suite, not next to 487 files sharing one process.
   */
});
