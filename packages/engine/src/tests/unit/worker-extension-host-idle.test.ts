/**
 * ADR 0062 d3 on the host alone, over a fake channel: a job run on the
 * extension's runner (`hold`) keeps it from being stopped for idleness, and a
 * process that ends — for idleness or an operator's stop — leaves no heartbeat
 * behind to count a crash later (ledger A02-2026-11-24-d4s2).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { Hono } from 'hono';
import type { HostToWorkerMessage } from '../../lib/worker-extension-protocol.js';
import type { ExtensionChannel } from '../../lib/worker-extension-transport.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';
import { signedWorkerDir } from '../../testing/operator-signed.js';

const saved = process.env.ZVELTIO_EXT_TRANSPORT;
const dirs: string[] = [];
afterEach(() => {
  if (saved === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
  else process.env.ZVELTIO_EXT_TRANSPORT = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A process that inits and never answers a ping. */
function fakeOpen(spawned: { n: number }) {
  return async (): Promise<ExtensionChannel> => {
    spawned.n++;
    const ch: ExtensionChannel = {
      onmessage: null,
      onerror: null,
      postMessage(m: HostToWorkerMessage) {
        if (m.type === 'init') {
          queueMicrotask(() =>
            ch.onmessage?.({ data: { type: 'init:ok', id: m.id } } as MessageEvent),
          );
        }
      },
      terminate() {},
    };
    return ch;
  };
}

async function started(name: string, runtime?: { alwaysOn: boolean; idleTimeoutMs: number }) {
  process.env.ZVELTIO_EXT_TRANSPORT = 'process';
  const spawned = { n: 0 };
  const host = new WorkerExtensionHost(new Hono(), fakeOpen(spawned), async () => null);
  const { dir, source } = await signedWorkerDir(name);
  dirs.push(dir);
  await host.start(name, dir, 'engine/index.js', { ...source, runtime });
  const status = () => host.getHealth().find((h) => h.name === name)?.status;
  return { host, spawned, status };
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(10);
  return done();
};

describe('worker host: idle stop (ADR 0062 d3)', () => {
  it('a job run on its runner holds it up; released, it idles out', async () => {
    const { host, status } = await started('idle-hold', { alwaysOn: true, idleTimeoutMs: 50 });
    // Running, as a call would leave it: then the operator turns always on off.
    host.setRuntime('idle-hold', { alwaysOn: false, idleTimeoutMs: 50 });
    const release = await host.hold('idle-hold');
    await Bun.sleep(200);
    expect(status()).toBe('running');
    release();
    expect(await until(() => status() === 'idle')).toBe(true);
    expect(host.getHealth()[0]?.recentCrashes).toBe(0);
  });

  it('an idle stop and an operator stop leave no heartbeat waiting on the ended process', async () => {
    const { host, status } = await started('idle-pings', { alwaysOn: true, idleTimeoutMs: 50 });
    const managed = _internalForTests.managed(host, 'idle-pings')!;
    _internalForTests.heartbeat(host, managed);
    expect(managed.pendingPings.size).toBe(1);
    host.setRuntime('idle-pings', { alwaysOn: false, idleTimeoutMs: 50 });
    expect(await until(() => status() === 'idle')).toBe(true);
    expect(managed.pendingPings.size).toBe(0);

    const other = await started('stop-pings');
    const m2 = _internalForTests.managed(other.host, 'stop-pings')!;
    _internalForTests.heartbeat(other.host, m2);
    await other.host.stop('stop-pings');
    expect(m2.pendingPings.size).toBe(0);
  });

  it('an idle one has no heartbeat: no process to answer it', async () => {
    const { host, spawned, status } = await started('idle-beat', {
      alwaysOn: false,
      idleTimeoutMs: 50,
    });
    // Its init ran once at load (no stamp store here), and that process ended.
    expect(spawned.n).toBe(1);
    expect(status()).toBe('idle');
    const m = _internalForTests.managed(host, 'idle-beat')!;
    _internalForTests.heartbeat(host, m);
    expect(m.pendingPings.size).toBe(0);
  });
});
