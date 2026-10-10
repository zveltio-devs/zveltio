/**
 * WorkerExtensionHost — init:err and 15s init timeout (worker-extension-host.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';
import { WorkerExtensionHost, _resetWorkerHostForTests } from '../../lib/worker-extension-host.js';
import type { ExtensionChannel } from '../../lib/worker-extension-transport.js';

/** A fake extension process: the host's channel opener returns it. */
const fakeChannel = (C: new () => unknown) => async () => new C() as unknown as ExtensionChannel;

afterEach(() => {
  _resetWorkerHostForTests();
});

describe('WorkerExtensionHost — init failures', () => {
  it('throws when the worker responds with init:err', async () => {
    const MockWorker = class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: HostToWorkerMessage) {
        if (msg.type === 'init') {
          queueMicrotask(() => {
            this.onmessage?.({
              data: { type: 'init:err', id: msg.id, error: 'bad manifest' },
            } as MessageEvent);
          });
        }
      }
      terminate() {}
    };

    const host = new WorkerExtensionHost(new Hono(), fakeChannel(MockWorker));
    await expect(host.start('init-err-ext', '/tmp/init-err', 'engine/index.js')).rejects.toThrow(
      /init failed: bad manifest/,
    );
    await host.stopAll().catch(() => {});
  });

  it('rejects when the worker does not init within 15s', async () => {
    const MockWorker = class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(_msg: HostToWorkerMessage) {
        /* never responds */
      }
      terminate() {}
    };

    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === 15_000) {
        return realSetTimeout(fn, 0, ...args);
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);

    const host = new WorkerExtensionHost(new Hono(), fakeChannel(MockWorker));
    try {
      await expect(
        host.start('init-timeout-ext', '/tmp/timeout', 'engine/index.js'),
      ).rejects.toThrow(/did not init within 15s/);
    } finally {
      timeoutSpy.mockRestore();
      await host.stopAll().catch(() => {});
    }
  });
});
