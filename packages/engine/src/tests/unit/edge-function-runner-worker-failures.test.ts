/**
 * edge-function-runner.ts — worker hard timeout + onerror paths.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { type EdgeRequest, runEdgeFunction } from '../../lib/edge-function-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
const OriginalWorker = globalThis.Worker;

afterEach(() => {
  globalThis.Worker = OriginalWorker;
});

describe('runEdgeFunction — worker failure paths', () => {
  it('resolves with Worker hard timeout when the worker never responds', async () => {
    class HangingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage() {}
      terminate() {}
    }
    globalThis.Worker = HangingWorker as unknown as typeof Worker;

    const res = await runEdgeFunction('async function handler() { return 1; }', REQ, {}, 50);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Worker hard timeout');
    expect(res.logs).toEqual([]);
  }, 10_000);

  it('returns the worker bootstrap error when onerror fires', async () => {
    class BrokenWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage() {
        queueMicrotask(() => this.onerror?.({ message: 'worker bootstrap failed' } as ErrorEvent));
      }
      terminate() {}
    }
    globalThis.Worker = BrokenWorker as unknown as typeof Worker;

    const res = await runEdgeFunction('async function handler() { return 1; }', REQ, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('worker bootstrap failed');
    expect(res.logs).toEqual([]);
  });
});
