/**
 * WorkerExtensionHost — host-side caller timeout for worker-registered services.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { Hono } from 'hono';
import { serviceRegistry } from '../../lib/service-registry.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { dispatchMessage, resetInvokeWaiters } = _internalForTests;

beforeEach(() => {
  jest.useFakeTimers();
  resetInvokeWaiters();
  serviceRegistry.unregisterAll('reg-timeout');
});

afterEach(() => {
  jest.useRealTimers();
  resetInvokeWaiters();
  serviceRegistry.unregisterAll('reg-timeout');
});

describe('WorkerExtensionHost — registered service invoke timeout', () => {
  it('rejects when a worker-registered service never answers service:invoke', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const posted: unknown[] = [];
    const managed = {
      name: 'reg-timeout',
      extDir: '/tmp/ext',
      bundleEntry: 'engine/index.js',
      worker: {
        postMessage: (msg: unknown) => {
          posted.push(msg);
        },
        terminate: () => {},
      } as unknown as Worker,
      routes: [],
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
    host.workers.set('reg-timeout', managed);

    dispatchMessage(host, managed, {
      type: 'service:register',
      id: 'reg-1',
      name: 'slow.registered',
    });
    await Promise.resolve();

    const callP = serviceRegistry.get<() => Promise<string>>('slow.registered')?.();
    await Promise.resolve();
    jest.advanceTimersByTime(30_001);

    await expect(callP).rejects.toThrow(/call timeout/i);
    expect(
      posted.some(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'service:invoke' &&
          (m as { name?: string }).name === 'slow.registered',
      ),
    ).toBe(true);
  });
});
