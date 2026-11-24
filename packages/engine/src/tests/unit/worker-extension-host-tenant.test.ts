/**
 * A worker route request is recorded on the host as the tenant the host
 * resolved from the request context, and the worker is handed neither that
 * tenant nor the caller: its `host` calls are answered from the host's record,
 * which does not outlive the request.
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
    proxyUnmount: () => {},
    workerGeneration: 1,
    enabledAt: Date.now(),
    inFlightRequests: 0,
    totalRequests: 0,
    stopped: false,
  } as any;
}

describe('worker route dispatch', () => {
  it('records the request tenant on the host and hands the worker neither tenant nor caller', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant' as never, { id: 't1' } as never);
      c.set('user' as never, { id: 'u1' } as never);
      await next();
    });
    const recorded: unknown[] = [];
    const host = new WorkerExtensionHost(app);
    const posted: Record<string, unknown>[] = [];
    const m = makeManaged('probe');
    m.routes = [{ method: 'GET', path: '/thing' }];
    m.worker = {
      postMessage: (msg: Record<string, unknown>) => {
        posted.push(msg);
        recorded.push(m.invokeTenants.get(msg.id as string)?.tenantId);
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
    expect(recorded).toEqual(['t1']);
    expect(invoke).not.toHaveProperty('tenantId');
    expect(invoke).not.toHaveProperty('user');
    // And the record does not outlive the request.
    expect(m.invokeTenants.size).toBe(0);
  });
});
