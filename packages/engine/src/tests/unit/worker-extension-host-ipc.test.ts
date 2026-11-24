import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { ActionHost } from '@zveltio/sdk/extension';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
} from '../../lib/worker-extension-protocol.js';
import {
  WorkerExtensionHost,
  _internalForTests,
  boxConcurrencyLimit,
  _resetWorkerHostForTests,
  getWorkerHost,
  getWorkerHostIfInitialized,
} from '../../lib/worker-extension-host.js';
import { encodeFrame, FrameDecoder } from '../../lib/worker-extension-transport.js';
import type { ExtensionChannel } from '../../lib/worker-extension-transport.js';

/** A fake extension process: the host's channel opener returns it. */
const fakeChannel = (C: new () => unknown) => async () => new C() as unknown as ExtensionChannel;

const { dispatchMessage, mountProxy, heartbeat, resetInvokeWaiters } = _internalForTests;

/** An action's host as `mountActions` builds it; the worker's calls never reach it here. */
const actionHost = { timezone: 'UTC' } as unknown as ActionHost;

function makeManaged(
  host: WorkerExtensionHost,
  overrides: {
    name: string;
    routes?: { method: string; path: string }[];
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
      terminate: mock(() => {}),
    } as unknown as ExtensionChannel,
    routes: overrides.routes ?? [],
    pendingInvokes: new Map(),
    invokeTenants: new Map(),
    pendingInits: new Map(),
    pendingPings: new Map(),
    proxyUnmount: () => {},
    workerGeneration: 1,
    enabledAt: Date.now(),
    inFlightRequests: 0,
    totalRequests: 0,
    stopped: false,
  };
  // @ts-expect-error — test seam into private map
  host.workers.set(overrides.name, managed);
  return { managed, posted };
}

describe('boxConcurrencyLimit', () => {
  it('is a quarter of the pool, never below one', () => {
    expect(boxConcurrencyLimit(40)).toBe(10);
    expect(boxConcurrencyLimit(10)).toBe(2);
    expect(boxConcurrencyLimit(2)).toBe(1);
  });
});

describe('WorkerExtensionHost — singleton', () => {
  beforeEach(() => _resetWorkerHostForTests());
  afterEach(() => _resetWorkerHostForTests());

  it('getWorkerHost returns a stable singleton', () => {
    const app = new Hono();
    const a = getWorkerHost(app);
    const b = getWorkerHost(app);
    expect(a).toBe(b);
    expect(getWorkerHostIfInitialized()).toBe(a);
  });
});

describe('WorkerExtensionHost — IPC message routing', () => {
  beforeEach(() => {
    _resetWorkerHostForTests();
    resetInvokeWaiters();
  });
  afterEach(() => {
    resetInvokeWaiters();
    _resetWorkerHostForTests();
  });

  it('resolves pending route invokes on route:ok', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, { name: 'route-ext' });
    const promise = new Promise<WorkerToHostMessage>((resolve) => {
      managed.pendingInvokes.set('inv-1', resolve);
    });
    dispatchMessage(host, managed, {
      type: 'route:ok',
      id: 'inv-1',
      status: 201,
      body: new TextEncoder().encode('created'),
    });
    const res = await promise;
    expect(res.type).toBe('route:ok');
    if (res.type === 'route:ok') expect(res.status).toBe(201);
  });

  it('acknowledges heartbeat pings with pong', () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, { name: 'ping-ext' });
    let cleared = false;
    managed.pendingPings.set('ping-1', () => {
      cleared = true;
    });
    dispatchMessage(host, managed, { type: 'pong', id: 'ping-1' });
    expect(cleared).toBe(true);
    expect(managed.pendingPings.has('ping-1')).toBe(false);
  });

  it('answers no frame outside the protocol, from any worker, unsigned too: no SQL, service or event crosses', async () => {
    // RFC v3 phase D slice 4 (S2): every worker is declared model only. The
    // test override's unsigned worker used to be served `service:call`,
    // `service:register` and `db:query` here; none of them is a frame any more.
    const bunSql = await import('../../db/bun-sql-dialect.js');
    const reserve = mock(async () => ({ unsafe: async () => [], release: () => undefined }));
    const poolSpy = spyOn(bunSql, 'getActiveBunPool').mockReturnValue({ reserve } as never);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const host = new WorkerExtensionHost(new Hono());
      const { managed, posted } = makeManaged(host, { name: 'off-ext' });
      for (const frame of [
        { type: 'db:query', id: 'db-1', sql: 'SELECT 1', params: [42] },
        { type: 'service:call', id: 'svc-1', name: 'x.y', args: [] },
        { type: 'service:register', id: 'reg-1', name: 'off-ext.y' },
      ]) {
        dispatchMessage(host, managed, frame as unknown as WorkerToHostMessage);
      }
      await new Promise((r) => setTimeout(r, 0));
      expect(reserve).not.toHaveBeenCalled();
      expect(posted).toEqual([]);
      // Logged once, naming the extension: a bundle posting in a loop floods nothing.
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain('off-ext');
      expect(String(errors.mock.calls[0]?.[0])).toContain('declared model only');
    } finally {
      poolSpy.mockRestore();
      errors.mockRestore();
    }
  });

  it('remounts a running worker on the current app and keeps it; none running, or respawning, is false', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, {
      name: 'remount-ext',
      routes: [{ method: 'GET', path: '/x' }],
    });
    const app = new Hono();
    host.rebindApp(app);
    expect(host.remount('remount-ext')).toBe(true);
    expect(managed.worker.terminate).not.toHaveBeenCalled();
    // The proxy is on the new app: a request reaches the worker, not a 404.
    const res = app.request('/ext/remount-ext/x');
    await new Promise((r) => setTimeout(r, 0));
    const [id] = managed.pendingInvokes.keys();
    managed.pendingInvokes.get(id!)?.({ type: 'route:ok', id: id!, status: 204 });
    expect((await res).status).toBe(204);
    expect(host.remount('absent-ext')).toBe(false);
    (managed as { respawning?: boolean }).respawning = true;
    expect(host.remount('remount-ext')).toBe(false);
  });

  it('rejects pending route invokes on route:err', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, { name: 'route-err-ext' });
    const promise = new Promise<WorkerToHostMessage>((resolve) => {
      managed.pendingInvokes.set('inv-err', resolve);
    });
    dispatchMessage(host, managed, {
      type: 'route:err',
      id: 'inv-err',
      error: 'handler failed',
    });
    const res = await promise;
    expect(res.type).toBe('route:err');
    if (res.type === 'route:err') expect(res.error).toBe('handler failed');
  });

  it('resolves pending init waiters on init:err', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, { name: 'init-err-ext' });
    const promise = new Promise<WorkerToHostMessage>((resolve) => {
      managed.pendingInits.set('init-err', resolve);
    });
    dispatchMessage(host, managed, {
      type: 'init:err',
      id: 'init-err',
      error: 'bad manifest',
    });
    const res = await promise;
    expect(res.type).toBe('init:err');
    if (res.type === 'init:err') expect(res.error).toBe('bad manifest');
  });

  it('resolves pending init waiters on init:ok', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, { name: 'init-ok-ext' });
    const promise = new Promise<WorkerToHostMessage>((resolve) => {
      managed.pendingInits.set('init-ok', resolve);
    });
    dispatchMessage(host, managed, {
      type: 'init:ok',
      id: 'init-ok',
    });
    const res = await promise;
    expect(res.type).toBe('init:ok');
  });

  it('forwards worker log lines to console', () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, { name: 'log-ext' });
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      dispatchMessage(host, managed, {
        type: 'log',
        level: 'log',
        message: 'hello from worker',
      });
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('hello from worker'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('ignores an action reply from a worker that was not asked', async () => {
    // The waiter pool is module-scoped; `expect` pins the worker the run went
    // to, so another worker cannot answer it with whatever it likes.
    const host = new WorkerExtensionHost(new Hono());
    let capturedId = '';
    const { managed: owner } = makeManaged(host, {
      name: 'owner-a',
      onPost: (msg) => {
        if (msg.type === 'action:invoke' && msg.name === 'secret') capturedId = msg.id;
      },
    });
    const { managed: impostor } = makeManaged(host, { name: 'caller-b' });
    const run = host.runAction('owner-a', 'secret', {}, actionHost);
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedId).not.toBe('');

    dispatchMessage(host, impostor, { type: 'action:ok', id: capturedId, result: 'forged' });
    await new Promise((r) => setTimeout(r, 0));

    // Dropped: the run is still pending, so the real owner can still answer.
    dispatchMessage(host, owner, { type: 'action:ok', id: capturedId, result: 'genuine' });
    expect(await run).toBe('genuine');
  });

  it('uses unguessable rpc ids', async () => {
    // Defence in depth behind the sender check: with sequential ids an
    // attacker does not even have to observe an id to name someone else's
    // pending run.
    const host = new WorkerExtensionHost(new Hono());
    const ids: string[] = [];
    makeManaged(host, {
      name: 'owner-a',
      onPost: (msg) => {
        if (msg.type === 'action:invoke') ids.push(msg.id);
      },
    });
    void host.runAction('owner-a', 'a', {}, actionHost).catch(() => {});
    void host.runAction('owner-a', 'a', {}, actionHost).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id).toMatch(/^inv-act-[0-9a-f-]{36}$/);
  });

  it('action:err rejects the caller with the worker\'s error', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, {
      name: 'owner-err',
      onPost: (msg) => {
        if (msg.type === 'action:invoke') {
          queueMicrotask(() =>
            dispatchMessage(host, managed, {
              type: 'action:err',
              id: msg.id,
              error: 'handler blew up',
            }),
          );
        }
      },
    });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(host.runAction('owner-err', 'boom', {}, actionHost)).rejects.toThrow(
        'handler blew up',
      );
    } finally {
      errors.mockRestore();
    }
  });

  it('settles an action in flight with 503 when its worker stops', async () => {
    const host = new WorkerExtensionHost(new Hono());
    makeManaged(host, { name: 'owner-a' });
    const run = host.runAction('owner-a', 'hang', {}, actionHost);
    await new Promise((r) => setTimeout(r, 0));
    await host.stop('owner-a');
    await expect(run).rejects.toMatchObject({
      status: 503,
      message:
        'extension "owner-a" stopped while running action "hang"; nothing it wrote was kept',
    });
  });
});

describe('WorkerExtensionHost — Hono proxy routes', () => {
  beforeEach(() => resetInvokeWaiters());
  afterEach(() => resetInvokeWaiters());

  it('forwards HTTP to the worker and returns the route:ok body', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const { managed } = makeManaged(host, {
      name: 'proxy-ext',
      routes: [{ method: 'GET', path: '/hello' }],
      onPost: (msg) => {
        if (msg.type === 'route:invoke') {
          queueMicrotask(() => {
            dispatchMessage(host, managed, {
              type: 'route:ok',
              id: msg.id,
              status: 200,
              body: new TextEncoder().encode('hello-world'),
            });
          });
        }
      },
    });
    mountProxy(host, managed);
    const res = await app.request('/ext/proxy-ext/hello');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello-world');
    expect(managed.totalRequests).toBe(1);
  });

  it('carries a binary request and response body through the frames unchanged', async () => {
    // Bytes that are not UTF-8: a text decode turned each into U+FFFD.
    const sent = new Uint8Array([0x25, 0x50, 0xff, 0xfe, 0x00, 0x80, 0xc3]);
    const across = <T>(msg: T): T => new FrameDecoder().push(encodeFrame(msg))[0] as T;
    let received: Uint8Array | undefined;
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const { managed } = makeManaged(host, {
      name: 'bin-ext',
      routes: [{ method: 'POST', path: '/upload' }],
      onPost: (raw) => {
        const msg = across(raw);
        if (msg.type === 'route:invoke') {
          received = msg.body;
          queueMicrotask(() => {
            dispatchMessage(
              host,
              managed,
              across({ type: 'route:ok', id: msg.id, status: 200, body: msg.body }),
            );
          });
        }
      },
    });
    mountProxy(host, managed);
    const res = await app.request('/ext/bin-ext/upload', { method: 'POST', body: sent });
    expect(res.status).toBe(200);
    expect([...(received ?? [])]).toEqual([...sent]);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...sent]);
  });

  it('returns 503 when the worker entry was removed', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const { managed } = makeManaged(host, {
      name: 'gone-ext',
      routes: [{ method: 'GET', path: '/' }],
    });
    mountProxy(host, managed);
    // @ts-expect-error — test seam
    host.workers.delete('gone-ext');
    const res = await app.request('/ext/gone-ext');
    expect(res.status).toBe(503);
  });

  it('returns 500 when the worker reports route:err', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const { managed } = makeManaged(host, {
      name: 'err-ext',
      routes: [{ method: 'POST', path: '/fail' }],
      onPost: (msg) => {
        if (msg.type === 'route:invoke') {
          queueMicrotask(() => {
            dispatchMessage(host, managed, {
              type: 'route:err',
              id: msg.id,
              error: 'boom',
            });
          });
        }
      },
    });
    mountProxy(host, managed);
    const res = await app.request('/ext/err-ext/fail', { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('boom');
  });
});

describe('WorkerExtensionHost — stop() teardown', () => {
  it('ends the worker and clears the worker map', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, { name: 'stop-ext' });
    const timer = setInterval(() => {}, 60_000);
    (managed as { heartbeatTimer?: ReturnType<typeof setInterval> }).heartbeatTimer = timer;
    await host.stop('stop-ext');
    expect(managed.worker.terminate).toHaveBeenCalled();
    expect(host.isRunning('stop-ext')).toBe(false);
    clearInterval(timer);
  });
});

describe('WorkerExtensionHost — start() over a fake channel', () => {
  afterEach(() => {
    _resetWorkerHostForTests();
  });

  it('spawns, inits, and mounts its declared routes under /ext/<name>, never one the worker claims', async () => {
    const MockWorker = class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: HostToWorkerMessage) {
        if (msg.type === 'init') {
          queueMicrotask(() => {
            this.onmessage?.({
              data: {
                type: 'init:ok',
                id: msg.id,
                // What an old runtime reported: not a route the host serves.
                routes: [{ method: 'GET', path: '/claimed' }],
              },
            } as MessageEvent);
          });
        }
      }
      terminate() {}
    };

    const app = new Hono();
    const host = new WorkerExtensionHost(app, fakeChannel(MockWorker));
    await host.start('mock-ext', '/tmp/mock-ext', 'engine/index.js', {
      declaredRoutes: [{ method: 'GET', path: '/ready', handler: 'ready' }],
    });
    expect(host.isRunning('mock-ext')).toBe(true);
    expect(host.getHealth()[0]?.routes).toBe(1);
    // @ts-expect-error — test seam
    expect(host.workers.get('mock-ext')!.routes).toEqual([{ method: 'GET', path: '/ready' }]);
    await host.stop('mock-ext');
  });
});

describe('WorkerExtensionHost — heartbeat hang detection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    _resetWorkerHostForTests();
  });

  it('records lastHangAt and bumps generation after a heartbeat timeout', async () => {
    const MockWorker = class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: HostToWorkerMessage) {
        if (msg.type === 'init') {
          queueMicrotask(() => {
            this.onmessage?.({
              data: { type: 'init:ok', id: msg.id },
            } as MessageEvent);
          });
        }
      }
      terminate() {}
    };

    const app = new Hono();
    const host = new WorkerExtensionHost(app, fakeChannel(MockWorker));
    await host.start('hang-ext', '/tmp/hang', 'engine/index.js');
    const managed = host.getHealth().find((h) => h.name === 'hang-ext');
    expect(managed?.workerGeneration).toBe(1);

    // @ts-expect-error — test seam
    const live = host.workers.get('hang-ext')!;
    heartbeat(host, live);
    jest.advanceTimersByTime(60_001);
    await Promise.resolve();
    jest.advanceTimersByTime(30_000);
    await Promise.resolve();

    const after = host.getHealth().find((h) => h.name === 'hang-ext');
    expect(after?.lastHangAt).toBeDefined();
    expect((after?.workerGeneration ?? 0) >= 1).toBe(true);
    await host.stopAll();
  });
});

describe('getWorkerHost — app rebinding across a hot-reload', () => {
  it('retargets the singleton at the freshly built app', async () => {
    const { getWorkerHost, _resetWorkerHostForTests } = await import(
      '../../lib/worker-extension-host.js'
    );
    _resetWorkerHostForTests();

    const first = new Hono();
    const host = getWorkerHost(first);

    // A hot-reload builds a new app and re-registers everything onto it. The
    // singleton used to ignore this argument and keep the original, so a
    // worker's proxy routes were mounted on the discarded app — whose router
    // had already served requests — and Hono threw "matcher is already built".
    const second = new Hono();
    expect(getWorkerHost(second)).toBe(host);
    expect((host as unknown as { app: Hono }).app).toBe(second);

    _resetWorkerHostForTests();
  });
});
