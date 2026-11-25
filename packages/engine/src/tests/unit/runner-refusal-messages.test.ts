/**
 * ADR 0062 step 1b: what an operator on a restricted platform reads when the
 * extension runner is missing (F22) or the kernel OOM-kills an extension (F23).
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { readOomKills, runnerMissing, startRunner } from '../../lib/ext-runner.js';
import { WorkerExtensionHost, _resetWorkerHostForTests } from '../../lib/worker-extension-host.js';
import type { ExtensionChannel } from '../../lib/worker-extension-transport.js';
import { signedWorkerDir } from '../../testing/operator-signed.js';

afterEach(() => _resetWorkerHostForTests());

describe('F22: no runner in this container', () => {
  it('runnerMissing names the cause only when neither a socket nor systemd exists', () => {
    expect(runnerMissing({}, () => null)).toContain('no extension runner in this container');
    expect(runnerMissing({ ZVELTIO_EXT_RUNNER_SOCKET: '/x' }, () => null)).toBeNull();
    expect(runnerMissing({}, () => '/bin/systemctl')).toBeNull();
  });

  it('startRunner refuses with that cause, not systemctl', async () => {
    const saved = { s: process.env.ZVELTIO_EXT_RUNNER_SOCKET, p: process.env.PATH };
    delete process.env.ZVELTIO_EXT_RUNNER_SOCKET;
    process.env.PATH = '/nonexistent';
    try {
      const err = await startRunner('x').catch((e: Error) => e);
      expect((err as Error).message).toContain('no extension runner in this container');
      expect((err as Error).message).not.toContain('systemctl');
    } finally {
      if (saved.s !== undefined) process.env.ZVELTIO_EXT_RUNNER_SOCKET = saved.s;
      process.env.PATH = saved.p;
    }
  });
});

describe('F23: OOM kill', () => {
  it('readOomKills reads the cgroup counter', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'oom-')), 'memory.events');
    writeFileSync(f, 'low 0\nhigh 0\nmax 3\noom 3\noom_kill 2\n');
    expect(readOomKills(f)).toBe(2);
    expect(readOomKills(`${f}.missing`)).toBeNull();
  });

  it('a crash after the counter rose is logged as an out-of-memory kill, naming extension and key', async () => {
    class W {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: { type: string; id: string }) {
        if (msg.type === 'init')
          queueMicrotask(() =>
            this.onmessage?.({ data: { type: 'init:ok', id: msg.id, routes: [] } } as MessageEvent),
          );
      }
      terminate() {}
    }
    let kills = 0;
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (() => 1) as unknown as typeof setTimeout,
    );
    const host = new WorkerExtensionHost(
      new Hono(),
      async () => new W() as unknown as ExtensionChannel,
      async () => kills,
    );
    try {
      const { dir, source } = await signedWorkerDir('oom-ext');
      await host.start('oom-ext', dir, 'engine/index.js', source);
      kills = 1; // the kernel killed it
      // @ts-expect-error — test seam into private map
      host.workers.get('oom-ext')!.worker.onerror?.({
        message: 'runner closed the connection',
      } as ErrorEvent);
      await Bun.sleep(20);
      const line = errSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes('out of memory'));
      expect(line).toContain('[ext:oom-ext key=test-operator]');
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      timeoutSpy.mockRestore();
      await host.stopAll().catch(() => {});
    }
  });
});
