/**
 * edge-function-runner.ts — worker hard timeout + onerror paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type EdgeRequest, runEdgeFunction } from '../../lib/edge-function-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
const OriginalWorker = globalThis.Worker;
let savedMode: string | undefined;

beforeEach(() => {
  // These cases are about the in-process worker path specifically. The runner
  // now defaults to `subprocess` — a process boundary is the only thing that
  // actually contains untrusted code — so the worker branch has to be selected
  // explicitly or none of this is exercised.
  savedMode = process.env.EDGE_SANDBOX_MODE;
  process.env.EDGE_SANDBOX_MODE = 'worker';
});

afterEach(() => {
  globalThis.Worker = OriginalWorker;
  if (savedMode === undefined) delete process.env.EDGE_SANDBOX_MODE;
  else process.env.EDGE_SANDBOX_MODE = savedMode;
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
