import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
} from '../../lib/worker-extension-protocol.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import {
  WorkerExtensionHost,
  _internalForTests,
  _resetWorkerHostForTests,
  getWorkerHost,
  getWorkerHostIfInitialized,
} from '../../lib/worker-extension-host.js';

const { dispatchMessage, mountProxy, heartbeat, resetInvokeWaiters } = _internalForTests;

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
    } as unknown as Worker,
    routes: overrides.routes ?? [],
    pendingInvokes: new Map(),
    invokeTenants: new Map(),
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
  // @ts-expect-error — test seam into private map
  host.workers.set(overrides.name, managed);
  return { managed, posted };
}

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
    serviceRegistry.unregisterAll('ipc-test');
    serviceRegistry.unregisterAll('owner-a');
    serviceRegistry.unregisterAll('caller-b');
  });
  afterEach(() => {
    resetInvokeWaiters();
    _resetWorkerHostForTests();
    serviceRegistry.unregisterAll('ipc-test');
    serviceRegistry.unregisterAll('owner-a');
    serviceRegistry.unregisterAll('caller-b');
    serviceRegistry.unregisterAll('engine');
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
      body: 'created',
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

  it('executes db:query via the host pool and posts db:ok', async () => {
    const bunSql = await import('../../db/bun-sql-dialect.js');
    // The bridge runs on a RESERVED connection: pool.unsafe() speaks the
    // simple-query protocol and would accept `…; DROP TABLE "user"` in one
    // message, so the mock has to expose reserve() like the real pool does.
    const poolSpy = spyOn(bunSql, 'getActiveBunPool').mockReturnValue({
      reserve: async () => ({
        unsafe: async (sql: string, params?: unknown[]) => [{ sql, n: params?.length ?? 0 }],
        release: () => undefined,
      }),
    } as never);

    const host = new WorkerExtensionHost(new Hono());
    const { managed, posted } = makeManaged(host, { name: 'db-ext' });
    await dispatchMessage(host, managed, {
      type: 'db:query',
      id: 'db-1',
      sql: 'SELECT 1',
      params: [42],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(posted.some((m) => m.type === 'db:ok' && m.id === 'db-1')).toBe(true);
    poolSpy.mockRestore();
  });

  it('posts db:err when the BunSQL pool is unavailable', async () => {
    const bunSql = await import('../../db/bun-sql-dialect.js');
    const poolSpy = spyOn(bunSql, 'getActiveBunPool').mockReturnValue(null);

    const host = new WorkerExtensionHost(new Hono());
    const { managed, posted } = makeManaged(host, { name: 'db-fail' });
    dispatchMessage(host, managed, {
      type: 'db:query',
      id: 'db-2',
      sql: 'SELECT 1',
      params: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    const err = posted.find((m) => m.type === 'db:err' && m.id === 'db-2');
    expect(err?.type).toBe('db:err');
    if (err?.type === 'db:err') expect(err.error).toContain('pool not initialized');
    poolSpy.mockRestore();
  });

  it('service:call resolves inline registry services', async () => {
    serviceRegistry.registerAs('engine', 'inline.echo', (value: unknown) => `echo:${value}`);
    const host = new WorkerExtensionHost(new Hono());
    const { managed, posted } = makeManaged(host, { name: 'svc-inline' });
    dispatchMessage(host, managed, {
      type: 'service:call',
      id: 'svc-1',
      name: 'inline.echo',
      args: ['hi'],
    });
    await new Promise((r) => setTimeout(r, 0));
    const ok = posted.find((m) => m.type === 'service:ok' && m.id === 'svc-1');
    expect(ok?.type).toBe('service:ok');
    if (ok?.type === 'service:ok') expect(ok.result).toBe('echo:hi');
  });

  it('service:call returns service:err for unknown services', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed, posted } = makeManaged(host, { name: 'svc-miss' });
    dispatchMessage(host, managed, {
      type: 'service:call',
      id: 'svc-2',
      name: 'no.such.service',
      args: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    const err = posted.find((m) => m.type === 'service:err' && m.id === 'svc-2');
    expect(err?.type).toBe('service:err');
    if (err?.type === 'service:err') expect(err.error).toContain('not found');
  });

  it('service:call returns service:err when an inline service throws', async () => {
    serviceRegistry.registerAs('engine', 'inline.boom', () => {
      throw new Error('inline exploded');
    });
    const host = new WorkerExtensionHost(new Hono());
    const { managed, posted } = makeManaged(host, { name: 'svc-throw' });
    dispatchMessage(host, managed, {
      type: 'service:call',
      id: 'svc-3',
      name: 'inline.boom',
      args: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    const err = posted.find((m) => m.type === 'service:err' && m.id === 'svc-3');
    expect(err?.type).toBe('service:err');
    if (err?.type === 'service:err') expect(err.error).toContain('inline exploded');
    serviceRegistry.unregisterAs('engine', 'inline.boom');
  });

  it('posts db:err when the pool query throws', async () => {
    const bunSql = await import('../../db/bun-sql-dialect.js');
    const poolSpy = spyOn(bunSql, 'getActiveBunPool').mockReturnValue({
      reserve: async () => ({
        unsafe: async (sql: string) => {
          // The guard issues SET statement_timeout first; only the extension's
          // own statement should surface the failure under test.
          if (sql.startsWith('SET ')) return [];
          throw new Error('query exploded');
        },
        release: () => undefined,
      }),
    } as never);

    const host = new WorkerExtensionHost(new Hono());
    const { managed, posted } = makeManaged(host, { name: 'db-throw' });
    dispatchMessage(host, managed, {
      type: 'db:query',
      id: 'db-3',
      sql: 'SELECT boom',
      params: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    const err = posted.find((m) => m.type === 'db:err' && m.id === 'db-3');
    expect(err?.type).toBe('db:err');
    if (err?.type === 'db:err') expect(err.error).toContain('query exploded');
    poolSpy.mockRestore();
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
      routes: [{ method: 'GET', path: '/ready' }],
    });
    const res = await promise;
    expect(res.type).toBe('init:ok');
    if (res.type === 'init:ok') expect(res.routes).toHaveLength(1);
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

  it('service:register publishes a worker-owned service callable from the host', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed, posted } = makeManaged(host, {
      name: 'owner-a',
      onPost: (msg) => {
        if (msg.type === 'service:invoke' && msg.name === 'a.ping') {
          queueMicrotask(() => {
            dispatchMessage(host, managed, {
              type: 'service:invoke:ok',
              id: msg.id,
              result: 'pong',
            });
          });
        }
      },
    });
    dispatchMessage(host, managed, {
      type: 'service:register',
      id: 'reg-1',
      name: 'a.ping',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(posted.some((m) => m.type === 'service:register:ok' && m.id === 'reg-1')).toBe(true);
    expect(managed.registeredServices.has('a.ping')).toBe(true);
    const result = await serviceRegistry.get<() => Promise<string>>('a.ping')?.();
    expect(result).toBe('pong');
  });

  it('ignores a service:invoke reply from a worker that was not asked', async () => {
    // The waiter pool is module-scoped and was keyed on the rpc id alone, with
    // no record of WHO the invoke went to — and the ids were `inv-svc-1`,
    // `inv-svc-2` from a process-wide counter. So a worker-isolated extension
    // could guess the id of a cross-extension call it was not party to and
    // answer it with whatever it liked, and the caller believed it: service
    // calls are how extensions trust each other.
    const host = new WorkerExtensionHost(new Hono());
    let capturedId = '';
    const { managed: owner } = makeManaged(host, {
      name: 'owner-a',
      onPost: (msg) => {
        if (msg.type === 'service:invoke' && msg.name === 'a.secret') capturedId = msg.id;
      },
    });
    const { managed: impostor } = makeManaged(host, { name: 'caller-b' });

    dispatchMessage(host, owner, { type: 'service:register', id: 'reg-2', name: 'a.secret' });
    await new Promise((r) => setTimeout(r, 0));

    const call = serviceRegistry.get<() => Promise<string>>('a.secret')!();
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedId).not.toBe('');

    // The impostor answers the owner's pending call.
    dispatchMessage(host, impostor, {
      type: 'service:invoke:ok',
      id: capturedId,
      result: 'forged',
    });
    await new Promise((r) => setTimeout(r, 0));

    // Dropped: the call is still pending, so the real owner can still answer.
    dispatchMessage(host, owner, { type: 'service:invoke:ok', id: capturedId, result: 'genuine' });
    expect(await call).toBe('genuine');
  });

  it('uses unguessable rpc ids', async () => {
    // Defence in depth behind the sender check: with `inv-svc-1`, `inv-svc-2`
    // an attacker does not even have to observe an id to name someone else's
    // pending call.
    const host = new WorkerExtensionHost(new Hono());
    const ids: string[] = [];
    const { managed } = makeManaged(host, {
      name: 'owner-a',
      onPost: (msg) => {
        if (msg.type === 'service:invoke') ids.push(msg.id);
      },
    });
    dispatchMessage(host, managed, { type: 'service:register', id: 'reg-3', name: 'a.ids' });
    await new Promise((r) => setTimeout(r, 0));
    const svc = serviceRegistry.get<() => Promise<string>>('a.ids')!;
    void svc();
    void svc();
    await new Promise((r) => setTimeout(r, 0));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id).toMatch(/^inv-svc-[0-9a-f-]{36}$/);
  });

  it('service:register:err when host registry registration throws', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed, posted } = makeManaged(host, { name: 'reg-fail' });
    const regSpy = spyOn(serviceRegistry, 'registerAs').mockImplementation(() => {
      throw new Error('registry full');
    });
    try {
      dispatchMessage(host, managed, {
        type: 'service:register',
        id: 'reg-bad',
        name: 'reg.fail',
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(
        posted.some(
          (m) =>
            m.type === 'service:register:err' && m.id === 'reg-bad' && m.error === 'registry full',
        ),
      ).toBe(true);
      expect(managed.registeredServices.has('reg.fail')).toBe(false);
    } finally {
      regSpy.mockRestore();
      serviceRegistry.unregisterAll('reg-fail');
    }
  });

  it('service:invoke:err rejects the host caller', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, {
      name: 'owner-err',
      onPost: (msg) => {
        if (msg.type === 'service:invoke' && msg.name === 'err.boom') {
          queueMicrotask(() => {
            dispatchMessage(host, managed, {
              type: 'service:invoke:err',
              id: msg.id,
              error: 'handler blew up',
            });
          });
        }
      },
    });
    dispatchMessage(host, managed, {
      type: 'service:register',
      id: 'reg-err',
      name: 'err.boom',
    });
    await new Promise((r) => setTimeout(r, 0));
    await expect(serviceRegistry.get<() => Promise<string>>('err.boom')?.()).rejects.toThrow(
      'handler blew up',
    );
    serviceRegistry.unregisterAll('owner-err');
  });

  it('service:call forwards to a different worker that owns the service', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed: owner, posted: ownerPosted } = makeManaged(host, {
      name: 'owner-svc',
      onPost: (msg) => {
        if (msg.type === 'service:invoke' && msg.name === 'owner.echo') {
          queueMicrotask(() => {
            dispatchMessage(host, owner, {
              type: 'service:invoke:ok',
              id: msg.id,
              result: 'echoed',
            });
          });
        }
      },
    });
    dispatchMessage(host, owner, {
      type: 'service:register',
      id: 'reg-owner',
      name: 'owner.echo',
    });
    await new Promise((r) => setTimeout(r, 0));

    const { managed: caller, posted: callerPosted } = makeManaged(host, { name: 'caller-svc' });
    dispatchMessage(host, caller, {
      type: 'service:call',
      id: 'cross-1',
      name: 'owner.echo',
      args: ['ping'],
    });
    await new Promise((r) => setTimeout(r, 0));

    const ok = callerPosted.find((m) => m.type === 'service:ok' && m.id === 'cross-1');
    expect(ok?.type).toBe('service:ok');
    if (ok?.type === 'service:ok') expect(ok.result).toBe('echoed');
    expect(ownerPosted.some((m) => m.type === 'service:invoke' && m.name === 'owner.echo')).toBe(
      true,
    );
    serviceRegistry.unregisterAll('owner-svc');
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
              body: 'hello-world',
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
  it('unregisters worker services and clears the worker map', async () => {
    const host = new WorkerExtensionHost(new Hono());
    const { managed } = makeManaged(host, { name: 'stop-ext' });
    managed.registeredServices.add('stop.svc');
    serviceRegistry.registerAs('stop-ext', 'stop.svc', () => 'x');
    const timer = setInterval(() => {}, 60_000);
    (managed as { heartbeatTimer?: ReturnType<typeof setInterval> }).heartbeatTimer = timer;
    await host.stop('stop-ext');
    expect(serviceRegistry.get('stop.svc')).toBeNull();
    expect(host.isRunning('stop-ext')).toBe(false);
    clearInterval(timer);
  });
});

describe('WorkerExtensionHost — mocked Worker start()', () => {
  const OriginalWorker = globalThis.Worker;

  afterEach(() => {
    globalThis.Worker = OriginalWorker;
    _resetWorkerHostForTests();
  });

  it('spawns, inits, and mounts proxy routes under /ext/<name>', async () => {
    globalThis.Worker = class MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: HostToWorkerMessage) {
        if (msg.type === 'init') {
          queueMicrotask(() => {
            this.onmessage?.({
              data: {
                type: 'init:ok',
                id: msg.id,
                routes: [{ method: 'GET', path: '/ready' }],
              },
            } as MessageEvent);
          });
        }
      }
      terminate() {}
    } as unknown as typeof Worker;

    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    await host.start('mock-ext', '/tmp/mock-ext', 'engine/index.js');
    expect(host.isRunning('mock-ext')).toBe(true);
    expect(host.getHealth()[0]?.routes).toBe(1);
    await host.stop('mock-ext');
  });
});

describe('WorkerExtensionHost — heartbeat hang detection', () => {
  const OriginalWorker = globalThis.Worker;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    globalThis.Worker = OriginalWorker;
    _resetWorkerHostForTests();
  });

  it('records lastHangAt and bumps generation after a heartbeat timeout', async () => {
    globalThis.Worker = class MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: HostToWorkerMessage) {
        if (msg.type === 'init') {
          queueMicrotask(() => {
            this.onmessage?.({
              data: { type: 'init:ok', id: msg.id, routes: [] },
            } as MessageEvent);
          });
        }
      }
      terminate() {}
    } as unknown as typeof Worker;

    const app = new Hono();
    const host = new WorkerExtensionHost(app);
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
