/**
 * WorkerExtensionHost — worker onerror schedules respawn (worker-extension-host.ts).
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

describe('WorkerExtensionHost — worker onerror', () => {
  it('logs and schedules a respawn when a running worker fires onerror', async () => {
    const MockWorker = class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: HostToWorkerMessage) {
        if (msg.type === 'init') {
          queueMicrotask(() => {
            this.onmessage?.({
              data: { type: 'init:ok', id: msg.id, routes: [] },
            } as MessageEvent);
          });
        }
      }
      terminate() {}
    };

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    let respawnFn: (() => void) | undefined;
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      respawnFn = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const app = new Hono();
    const host = new WorkerExtensionHost(app, fakeChannel(MockWorker));
    try {
      await host.start('crash-ext', '/tmp/crash', 'engine/index.js');
      // @ts-expect-error — test seam into private map
      const managed = host.workers.get('crash-ext')!;
      managed.worker.onerror?.({ message: 'wasm trap' } as ErrorEvent);

      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[worker:crash-ext] error'))).toBe(
        true,
      );
      expect(respawnFn).toBeDefined();
      respawnFn?.();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Respawning worker'))).toBe(true);
    } finally {
      warn.mockRestore();
      errSpy.mockRestore();
      timeoutSpy.mockRestore();
      await host.stopAll().catch(() => {});
    }
  });
});
