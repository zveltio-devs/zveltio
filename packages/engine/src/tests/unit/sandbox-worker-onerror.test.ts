/**
 * edge-functions/sandbox.ts — worker onerror path.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { runFunction } from '../../lib/edge-functions/sandbox.js';

const OriginalWorker = globalThis.Worker;

afterEach(() => {
  globalThis.Worker = OriginalWorker;
});

describe('runFunction — worker onerror', () => {
  it('returns a 500 with the worker error message when onerror fires', async () => {
    class BrokenWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage() {
        queueMicrotask(() => this.onerror?.({ message: 'worker bootstrap failed' } as ErrorEvent));
      }
      terminate() {}
    }
    globalThis.Worker = BrokenWorker as unknown as typeof Worker;

    const res = await runFunction(
      'async function handler() { return new Response("ok"); }',
      new Request('https://fn.local/run'),
      {},
      5000,
    );
    expect(res.status).toBe(500);
    expect(res.error).toBe('worker bootstrap failed');
    expect(res.body).toBe('');
  });
});
