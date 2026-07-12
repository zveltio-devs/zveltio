/**
 * edge-functions/sandbox.ts — memory watchdog tolerates memoryUsage() failures.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { runFunction } from '../../lib/edge-functions/sandbox.js';

const OriginalWorker = globalThis.Worker;

afterEach(() => {
  globalThis.Worker = OriginalWorker;
});

describe('runFunction — memoryUsage unavailable', () => {
  it('skips the parent heap check when memoryUsage throws', async () => {
    class OkWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage() {
        queueMicrotask(() => {
          this.onmessage?.({
            data: {
              success: true,
              status: 200,
              body: 'ok',
              logs: [],
              duration_ms: 1,
            },
          } as MessageEvent);
        });
      }
      terminate() {}
    }
    globalThis.Worker = OkWorker as unknown as typeof Worker;

    let memCheck: (() => void) | undefined;
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      memCheck = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    spyOn(process, 'memoryUsage').mockImplementation((() => {
      throw new Error('memoryUsage unavailable');
    }) as unknown as NodeJS.MemoryUsageFn);

    const resP = runFunction(
      'async function handler() { return new Response("ok"); }',
      new Request('https://fn.local/run'),
      {},
      5000,
    );
    memCheck?.();
    const res = await resP;

    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    intervalSpy.mockRestore();
  });
});
