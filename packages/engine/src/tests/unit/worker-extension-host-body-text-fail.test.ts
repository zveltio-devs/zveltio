/**
 * worker-extension-host.ts — proxy route body read failure uses empty body.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { dispatchMessage, mountProxy, resetInvokeWaiters } = _internalForTests;

afterEach(() => resetInvokeWaiters());

describe('WorkerExtensionHost — body text read failure', () => {
  it('forwards route:invoke with undefined body when Request.text() throws', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    let capturedBody: string | undefined = 'unset';

    const managed = {
      name: 'body-ext',
      extDir: '/tmp/ext',
      bundleEntry: 'engine/index.js',
      worker: {
        postMessage: (msg: HostToWorkerMessage) => {
          if (msg.type === 'route:invoke') {
            capturedBody = msg.body;
            queueMicrotask(() => {
              dispatchMessage(host, managed, {
                type: 'route:ok',
                id: msg.id,
                status: 204,
                body: '',
              });
            });
          }
        },
        terminate: () => {},
      } as unknown as Worker,
      routes: [{ method: 'POST', path: '/ingest' }],
      pendingInvokes: new Map(),
      pendingInits: new Map(),
      pendingPings: new Map(),
      registeredServices: new Set<string>(),
      proxyUnmount: () => {},
      workerGeneration: 1,
      enabledAt: Date.now(),
      inFlightRequests: 0,
      totalRequests: 0,
      stopped: false,
    };
    // @ts-expect-error — test seam into private map
    host.workers.set('body-ext', managed);

    mountProxy(host, managed);

    const textSpy = spyOn(Request.prototype, 'text').mockRejectedValue(new Error('body locked'));
    try {
      const res = await app.request('/ext/body-ext/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"drop":true}',
      });
      expect(res.status).toBe(204);
      expect(capturedBody).toBeUndefined();
    } finally {
      textSpy.mockRestore();
    }
  });
});
