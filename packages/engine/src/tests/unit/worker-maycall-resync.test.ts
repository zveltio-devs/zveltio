// A worker answers ctx.services.has() from its own copy of its ServiceDeps,
// sent at init. When an optional dependency is upgraded past the dependent's
// minVersion (lifecycle refreshTooOldDependents), the host map turns callable
// and the worker must be told: the snapshot carries the map again.
import { expect, it } from 'bun:test';
import { Hono } from 'hono';
import { WorkerExtensionHost } from '../../lib/worker-extension-host.js';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';

it('resyncServices sends each worker its current ServiceDeps', async () => {
  const host = new WorkerExtensionHost(new Hono());
  const posted: HostToWorkerMessage[] = [];
  const mayCall = new Map([['dep', false]]);
  (host as unknown as { workers: Map<string, unknown> }).workers.set('w', {
    name: 'w',
    stopped: false,
    mayCall,
    worker: { postMessage: (m: HostToWorkerMessage) => posted.push(m) },
  });

  mayCall.set('dep', true);
  host.resyncServices();
  host.resyncServices(); // coalesced: one snapshot per tick
  await Promise.resolve();

  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ type: 'services:snapshot', mayCall: [['dep', true]] });
});
