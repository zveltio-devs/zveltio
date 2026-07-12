/**
 * WorkerExtensionHost — unsupported HTTP methods are not proxied.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { mountProxy, resetInvokeWaiters } = _internalForTests;

afterEach(() => resetInvokeWaiters());

describe('WorkerExtensionHost — route method filter', () => {
  it('does not mount OPTIONS routes declared by the worker', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const managed = {
      name: 'opts-ext',
      extDir: '/tmp/ext',
      bundleEntry: 'engine/index.js',
      worker: { postMessage: () => {}, terminate: () => {} } as unknown as Worker,
      routes: [{ method: 'OPTIONS', path: '/ok' }],
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
    host.workers.set('opts-ext', managed);
    mountProxy(host, managed);

    const optRes = await app.request('/ext/opts-ext/ok', { method: 'OPTIONS' });
    expect(optRes.status).toBe(404);
  });
});
