/**
 * WorkerExtensionHost — Hono proxy forwards request headers to route:invoke.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { dispatchMessage, mountProxy, resetInvokeWaiters } = _internalForTests;

afterEach(() => resetInvokeWaiters());

describe('WorkerExtensionHost — proxy header forwarding', () => {
  it('includes incoming request headers on route:invoke', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    let capturedHeaders: Record<string, string> | undefined;

    const managed = {
      name: 'hdr-ext',
      extDir: '/tmp/ext',
      bundleEntry: 'engine/index.js',
      worker: {
        postMessage: (msg: HostToWorkerMessage) => {
          if (msg.type === 'route:invoke') {
            capturedHeaders = msg.headers;
            queueMicrotask(() => {
              dispatchMessage(host, managed, {
                type: 'route:ok',
                id: msg.id,
                status: 200,
                body: 'ok',
              });
            });
          }
        },
        terminate: () => {},
      } as unknown as Worker,
      routes: [{ method: 'POST', path: '/echo' }],
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
    host.workers.set('hdr-ext', managed);

    mountProxy(host, managed);

    const res = await app.request('/ext/hdr-ext/echo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Token': 'abc123',
      },
      body: '{"hello":true}',
    });

    expect(res.status).toBe(200);
    expect(capturedHeaders?.['x-custom-token']).toBe('abc123');
    expect(capturedHeaders?.['content-type']).toContain('application/json');
  });
});
