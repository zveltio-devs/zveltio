/**
 * edge-functions/sandbox.ts — POST request body serialization into worker payload.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { runFunction } from '../../lib/edge-functions/sandbox.js';

const OriginalWorker = globalThis.Worker;

afterEach(() => {
  globalThis.Worker = OriginalWorker;
});

describe('runFunction — request serialization', () => {
  it('passes POST body text to the worker and returns the handler response', async () => {
    class CapturingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      lastPayload: { requestData: { body: string | null; method: string } } | null = null;
      postMessage(data: { requestData: { body: string | null; method: string } }) {
        this.lastPayload = data;
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              success: true,
              status: 200,
              body: data.requestData.body ?? '',
              logs: [],
              duration_ms: 1,
            },
          } as MessageEvent),
        );
      }
      terminate() {}
    }
    globalThis.Worker = CapturingWorker as unknown as typeof Worker;

    const res = await runFunction(
      'async function handler() { return new Response("ok"); }',
      new Request('https://fn.local/run', {
        method: 'POST',
        body: '{"x":1}',
        headers: { 'Content-Type': 'application/json' },
      }),
      {},
      5000,
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"x":1}');
  });

  it('sends null body for GET requests', async () => {
    class CapturingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(data: { requestData: { body: string | null } }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              success: true,
              status: 200,
              body: String(data.requestData.body),
              logs: [],
              duration_ms: 1,
            },
          } as MessageEvent),
        );
      }
      terminate() {}
    }
    globalThis.Worker = CapturingWorker as unknown as typeof Worker;

    const res = await runFunction(
      'async function handler() { return new Response("ok"); }',
      new Request('https://fn.local/run', { method: 'GET' }),
      {},
      5000,
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe('null');
  });
});
