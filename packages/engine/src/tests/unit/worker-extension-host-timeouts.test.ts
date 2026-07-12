/**
 * WorkerExtensionHost — cross-worker service + route invoke timeouts.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { Hono } from 'hono';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { dispatchMessage, resetInvokeWaiters } = _internalForTests;

function makeManaged(
  host: WorkerExtensionHost,
  overrides: {
    name: string;
    routes?: { method: string; path: string }[];
    registeredServices?: string[];
  },
) {
  const posted: unknown[] = [];
  const managed = {
    name: overrides.name,
    extDir: '/tmp/ext',
    bundleEntry: 'engine/index.js',
    worker: {
      postMessage: (msg: unknown) => {
        posted.push(msg);
      },
      terminate: () => {},
    } as unknown as Worker,
    routes: overrides.routes ?? [],
    pendingInvokes: new Map(),
    pendingInits: new Map(),
    pendingPings: new Map(),
    registeredServices: new Set(overrides.registeredServices ?? []),
    proxyUnmount: () => {},
    workerGeneration: 1,
    enabledAt: Date.now(),
    inFlightRequests: 0,
    totalRequests: 0,
    stopped: false,
  };
  // @ts-expect-error — test seam
  host.workers.set(overrides.name, managed);
  return { managed, posted };
}

beforeEach(() => {
  jest.useFakeTimers();
  resetInvokeWaiters();
});

afterEach(() => {
  jest.useRealTimers();
  resetInvokeWaiters();
});

describe('WorkerExtensionHost — invoke timeouts', () => {
  it('returns service:err when a cross-worker service call times out', async () => {
    const host = new WorkerExtensionHost(new Hono());
    makeManaged(host, { name: 'owner-timeout', registeredServices: ['slow.svc'] });
    const { managed: caller, posted } = makeManaged(host, { name: 'caller-timeout' });

    dispatchMessage(host, caller, {
      type: 'service:call',
      id: 'svc-timeout',
      name: 'slow.svc',
      args: [],
    });

    await Promise.resolve();
    jest.advanceTimersByTime(30_001);
    await Promise.resolve();

    const err = posted.find(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type?: string }).type === 'service:err' &&
        (m as { id?: string }).id === 'svc-timeout',
    ) as { error?: string } | undefined;
    expect(err?.error).toContain('call timeout');
  });
});
