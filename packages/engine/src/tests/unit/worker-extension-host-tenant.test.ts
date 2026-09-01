/**
 * Which tenant does a worker's SQL run as?
 *
 * Worker-isolated extensions do not hold a database connection — every query
 * crosses the IPC bridge and the HOST executes it. The host executed it on the
 * engine's pool with no tenant context at all, and said so in a comment: "the
 * query runs on the engine's pool rather than the caller's tenant transaction,
 * so it is not RLS-scoped". Since `enforcePublisherTier` sends UNTRUSTED
 * community extensions down the worker path specifically because the worker is
 * meant to be the boundary, that was the boundary leaking at its narrowest
 * point.
 *
 * The fix threads the tenant through, and the interesting part is where the
 * tenant comes from. The worker names the `route:invoke` it is handling; the
 * host looks the tenant up in ITS OWN dispatch record. It never reads a tenant
 * from the message — a tenant the worker states is a tenant the worker chose,
 * which is the same mistake as trusting a `keyId` out of an unverified
 * signature envelope.
 *
 * These cases pin that distinction, plus the lifetime of the record.
 */

import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { resolveDbTenant } = _internalForTests;

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

function makeManaged(name = 'probe') {
  return {
    name,
    extDir: '/tmp/ext',
    bundleEntry: 'engine/index.js',
    worker: { postMessage: mock(() => {}), terminate: mock(() => {}) } as unknown as Worker,
    routes: [],
    pendingInvokes: new Map(),
    invokeTenants: new Map<string, string | null>(),
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

describe('worker db:query tenant resolution', () => {
  it('resolves the tenant of the request the host dispatched', () => {
    const m = makeManaged();
    m.invokeTenants.set('inv-1', TENANT_A);
    expect(resolveDbTenant(m, 'inv-1')).toBe(TENANT_A);
  });

  it('gives nothing for an invocation id the host never issued', () => {
    // A worker inventing an id must not obtain a tenant context. `undefined`
    // means the query runs with no GUC, which the isolation predicate resolves
    // to the default tenant — not to everything.
    const m = makeManaged();
    m.invokeTenants.set('inv-1', TENANT_A);
    expect(resolveDbTenant(m, 'inv-made-up')).toBeUndefined();
  });

  it('gives nothing for a query issued outside any request', () => {
    // Background hooks and scheduled tasks have no caller to inherit from.
    const m = makeManaged();
    m.invokeTenants.set('inv-1', TENANT_A);
    expect(resolveDbTenant(m, undefined)).toBeUndefined();
  });

  it('keeps each concurrent invocation on its own tenant', () => {
    // Two requests in flight on one worker. A module-level "current tenant"
    // would have let the second overwrite the first — which is one tenant's
    // query running in another tenant's context, the exact bug being fixed.
    const m = makeManaged();
    m.invokeTenants.set('inv-1', TENANT_A);
    m.invokeTenants.set('inv-2', TENANT_B);
    expect(resolveDbTenant(m, 'inv-1')).toBe(TENANT_A);
    expect(resolveDbTenant(m, 'inv-2')).toBe(TENANT_B);
  });

  it('cannot be reached from another worker', () => {
    // The record is per worker, so extension X cannot quote an id belonging to
    // a request dispatched to extension Y.
    const x = makeManaged('x');
    const y = makeManaged('y');
    x.invokeTenants.set('inv-1', TENANT_A);
    expect(resolveDbTenant(y, 'inv-1')).toBeUndefined();
  });

  it('forgets the tenant once the request has finished', () => {
    // Otherwise the map grows for the process lifetime and a worker could keep
    // quoting a completed request's id to hold onto its tenant context.
    const m = makeManaged();
    m.invokeTenants.set('inv-1', TENANT_A);
    m.invokeTenants.delete('inv-1');
    expect(resolveDbTenant(m, 'inv-1')).toBeUndefined();
  });
});

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
