/**
 * WorkerExtensionHost — respawn failure loop (worker-extension-host.ts).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';
import { WorkerExtensionHost, _resetWorkerHostForTests } from '../../lib/worker-extension-host.js';

const OriginalWorker = globalThis.Worker;

afterEach(() => {
  globalThis.Worker = OriginalWorker;
  _resetWorkerHostForTests();
});

describe('WorkerExtensionHost — respawn failure', () => {
  it('logs and re-schedules when respawn spawn fails', async () => {
    let spawnCount = 0;

    globalThis.Worker = class MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      generation = ++spawnCount;

      postMessage(msg: HostToWorkerMessage) {
        if (msg.type === 'init') {
          queueMicrotask(() => {
            if (this.generation === 1) {
              this.onmessage?.({
                data: { type: 'init:ok', id: msg.id, routes: [] },
              } as MessageEvent);
            } else {
              this.onmessage?.({
                data: { type: 'init:err', id: msg.id, error: 'respawn boom' },
              } as MessageEvent);
            }
          });
        }
      }
      terminate() {}
    } as unknown as typeof Worker;

    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    let respawnFn: (() => void) | undefined;
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      respawnFn = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    try {
      await host.start('respawn-fail-ext', '/tmp/respawn', 'engine/index.js');
      // @ts-expect-error — test seam into private map
      const managed = host.workers.get('respawn-fail-ext')!;
      managed.worker.onerror?.({ message: 'crash' } as ErrorEvent);

      expect(respawnFn).toBeDefined();
      await respawnFn?.();

      expect(
        errSpy.mock.calls.some((c) =>
          String(c[0]).includes('Respawn failed for "respawn-fail-ext"'),
        ),
      ).toBe(true);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('respawn-failed'))).toBe(true);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      timeoutSpy.mockRestore();
      await host.stopAll().catch(() => {});
    }
  });
});
