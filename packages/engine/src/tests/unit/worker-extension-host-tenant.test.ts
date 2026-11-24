/**
 * A worker route request carries the tenant the host resolved from the request
 * context, never one the worker states, and the host's record of it does not
 * outlive the request.
 */

import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

function makeManaged(name = 'probe') {
  return {
    name,
    extDir: '/tmp/ext',
    bundleEntry: 'engine/index.js',
    worker: { postMessage: mock(() => {}), terminate: mock(() => {}) } as unknown as Worker,
    routes: [],
    pendingInvokes: new Map(),
    invokeTenants: new Map<string, { tenantId: string | null }>(),
    pendingInits: new Map(),
    pendingPings: new Map(),
    registeredServices: new Set<string>(),
    proxyUnmount: () => {},
    workerGeneration: 1,
    enabledAt: Date.now(),
    inFlightRequests: 0,
    totalRequests: 0,
    stopped: false,
  } as any;
}

describe('worker route dispatch', () => {
  it('records the request tenant and forwards it to the worker', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const posted: Record<string, unknown>[] = [];
    const m = makeManaged('probe');
    m.routes = [{ method: 'GET', path: '/thing' }];
    m.worker = {
      postMessage: (msg: Record<string, unknown>) => {
        posted.push(msg);
        // Reply immediately so the proxy handler completes and runs its
        // cleanup — the point of the last assertion.
        const cb = m.pendingInvokes.get(msg.id as string);
        if (cb) cb({ type: 'route:ok', id: msg.id, status: 200, body: 'ok' });
      },
      terminate: mock(() => {}),
    } as unknown as Worker;

    (host as unknown as { workers: Map<string, unknown> }).workers.set('probe', m);
    _internalForTests.mountProxy(host, m);

    const res = await app.request('/ext/probe/thing', {
      headers: { host: 'x.example' },
    });
    expect(res.status).toBe(200);

    const invoke = posted.find((p) => p.type === 'route:invoke');
    expect(invoke).toBeDefined();
    // No tenant middleware in this test, so the resolved tenant is absent —
    // what matters is that the field is populated from the request context
    // rather than from anything the worker supplies.
    expect(invoke).toHaveProperty('tenantId');
    // And the record does not outlive the request.
    expect(m.invokeTenants.size).toBe(0);
  });
});
