/**
 * edge-functions/sandbox.ts — memory watchdog kills runaway workers.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { runFunction } from '../../lib/edge-functions/sandbox.js';

const OriginalWorker = globalThis.Worker;
const HEAP_4X_LIMIT = 64 * 1024 * 1024 * 4 + 1;

afterEach(() => {
  globalThis.Worker = OriginalWorker;
});

describe('runFunction — memory watchdog', () => {
  it('returns 507 when heap usage exceeds the safety threshold', async () => {
    class SlowWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage() {}
      terminate() {}
    }
    globalThis.Worker = SlowWorker as unknown as typeof Worker;

    let memCheck: (() => void) | undefined;
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      memCheck = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    spyOn(process, 'memoryUsage').mockReturnValue({
      heapUsed: HEAP_4X_LIMIT,
      heapTotal: HEAP_4X_LIMIT,
      rss: HEAP_4X_LIMIT,
      external: 0,
      arrayBuffers: 0,
    });

    const resP = runFunction(
      'async function handler() { return new Response("ok"); }',
      new Request('https://fn.local/run'),
      {},
      5000,
    );
    memCheck?.();
    const res = await resP;

    expect(res.status).toBe(507);
    expect(res.error).toMatch(/memory limit/i);
    expect(res.error).toMatch(/256MB/);
    intervalSpy.mockRestore();
  });
});
