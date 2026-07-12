/**
 * WorkerExtensionHost — route:ok response headers are forwarded to the client.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { dispatchMessage, mountProxy, resetInvokeWaiters } = _internalForTests;

afterEach(() => resetInvokeWaiters());

describe('WorkerExtensionHost — route response headers', () => {
  it('returns custom headers from route:ok', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const managed = {
      name: 'hdr-resp-ext',
      extDir: '/tmp/ext',
      bundleEntry: 'engine/index.js',
      worker: {
        postMessage: (msg: HostToWorkerMessage) => {
          if (msg.type === 'route:invoke') {
            queueMicrotask(() => {
              dispatchMessage(host, managed, {
                type: 'route:ok',
                id: msg.id,
                status: 204,
                body: '',
                headers: { 'x-worker': 'yes', 'cache-control': 'no-store' },
              });
            });
          }
        },
        terminate: () => {},
      } as unknown as Worker,
      routes: [{ method: 'DELETE', path: '/item' }],
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
    // @ts-expect-error — test seam
    host.workers.set('hdr-resp-ext', managed);
    mountProxy(host, managed);

    const res = await app.request('/ext/hdr-resp-ext/item', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.headers.get('x-worker')).toBe('yes');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
