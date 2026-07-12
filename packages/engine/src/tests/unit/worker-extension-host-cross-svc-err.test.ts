/**
 * WorkerExtensionHost — cross-worker service:call receives service:invoke:err.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { dispatchMessage, resetInvokeWaiters } = _internalForTests;

function makeManaged(
  host: WorkerExtensionHost,
  overrides: {
    name: string;
    registeredServices?: string[];
    onPost?: (msg: HostToWorkerMessage) => void;
  },
) {
  const posted: HostToWorkerMessage[] = [];
  const managed = {
    name: overrides.name,
    extDir: '/tmp/ext',
    bundleEntry: 'engine/index.js',
    worker: {
      postMessage: (msg: HostToWorkerMessage) => {
        posted.push(msg);
        overrides.onPost?.(msg);
      },
      terminate: () => {},
    } as unknown as Worker,
    routes: [],
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

beforeEach(() => resetInvokeWaiters());
afterEach(() => resetInvokeWaiters());

describe('WorkerExtensionHost — cross-worker service errors', () => {
  it('posts service:err when the owning worker replies with service:invoke:err', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed: owner } = makeManaged(host, {
      name: 'owner-fail',
      registeredServices: ['fail.echo'],
      onPost: (msg) => {
        if (msg.type === 'service:invoke' && msg.name === 'fail.echo') {
          queueMicrotask(() => {
            dispatchMessage(host, owner, {
              type: 'service:invoke:err',
              id: msg.id,
              error: 'remote handler exploded',
            });
          });
        }
      },
    });

    const { managed: caller, posted } = makeManaged(host, { name: 'caller-fail' });
    dispatchMessage(host, caller, {
      type: 'service:call',
      id: 'cross-err',
      name: 'fail.echo',
      args: ['ping'],
    });

    await new Promise((r) => setTimeout(r, 0));

    const err = posted.find((m) => m.type === 'service:err' && m.id === 'cross-err');
    expect(err?.type).toBe('service:err');
    if (err?.type === 'service:err') {
      expect(err.error).toBe('remote handler exploded');
    }
  });
});
