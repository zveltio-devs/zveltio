// The host side of the step-7 ctx contract: a worker's `host:call` is answered
// from the host's own record of the request it names — never from anything the
// worker says about who it is, which tenant it serves or which extension it is.
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
} from '../../lib/worker-extension-protocol.js';
import { callableDeps } from '../../lib/service-registry.js';
import { problem } from '../../lib/problem.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { dispatchMessage, mountProxy } = _internalForTests;
const U1 = 'user-1';
const GOD = 'user-god';

function setup(name = 'probe', deps: string[] = []) {
  const host = new WorkerExtensionHost(new Hono());
  const posted: HostToWorkerMessage[] = [];
  const checks: unknown[][] = [];
  const managed = {
    name,
    worker: {
      postMessage: (m: HostToWorkerMessage): void => {
        posted.push(m);
      },
      terminate() {},
    },
    routes: [] as { method: string; path: string }[],
    pendingInvokes: new Map(),
    invokeTenants: new Map<string, unknown>(),
    registeredServices: new Set<string>(),
    dependencies: new Set(deps),
    mayCall: callableDeps(deps),
    source: {
      checkPermission: async (...args: unknown[]) => {
        checks.push(args);
        return true;
      },
    },
    proxyUnmount: () => {},
    stopped: false,
  };
  // The host's record of a request it dispatched for U1.
  managed.invokeTenants.set('inv-1', { tenantId: null, user: { id: U1 } });
  const call = async (msg: Record<string, unknown>) => {
    posted.length = 0;
    dispatchMessage(
      host,
      managed as never,
      {
        type: 'host:call',
        id: 'c1',
        ...msg,
      } as unknown as WorkerToHostMessage,
    );
    for (let i = 0; i < 20 && posted.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    return posted[0] as {
      type: string;
      id?: string;
      result?: unknown;
      error?: string;
      status?: number;
    };
  };
  return { host, managed, call, checks, posted };
}

describe('worker host call: checkPermission', () => {
  it("answers for the request's user, with the inline extension's own check", async () => {
    const { call, checks } = setup();
    const res = await call({
      op: 'checkPermission',
      args: [U1, 'crm', 'read'],
      requestId: 'inv-1',
    });
    expect(res).toEqual({ type: 'host:ok', id: 'c1', result: true });
    expect(checks).toEqual([[U1, 'crm', 'read']]);
  });

  it('refuses any other user the worker names, without asking Casbin', async () => {
    const { call, checks } = setup();
    const res = await call({
      op: 'checkPermission',
      args: [GOD, 'crm', 'read'],
      requestId: 'inv-1',
    });
    expect(res.result).toBe(false);
    expect(checks).toEqual([]);
  });

  it('ignores an identity smuggled into the message', async () => {
    const { call, checks } = setup();
    const res = await call({
      op: 'checkPermission',
      args: [GOD, 'crm', 'read'],
      requestId: 'inv-1',
      user: { id: GOD },
      tenantId: 'other-tenant',
    });
    expect(res.result).toBe(false);
    expect(checks).toEqual([]);
  });

  it('answers false outside any request', async () => {
    const { call, checks } = setup();
    const res = await call({ op: 'checkPermission', args: [U1, 'crm', 'read'] });
    expect(res.result).toBe(false);
    expect(checks).toEqual([]);
  });

  it('refuses a request id the host never issued, or that is over', async () => {
    const { call } = setup();
    const res = await call({
      op: 'checkPermission',
      args: [U1, 'crm', 'read'],
      requestId: 'inv-x',
    });
    expect(res.type).toBe('host:err');
    expect(res.error).toContain('is over (or was never issued)');
  });

  it("cannot borrow another extension's request", async () => {
    const other = setup('other');
    const res = await other.call({
      op: 'checkPermission',
      args: [U1, 'crm', 'read'],
      requestId: 'inv-elsewhere',
    });
    expect(res.type).toBe('host:err');
  });

  it('carries a 503 the check raises, as inline problemOnError would answer it', async () => {
    const { call, managed } = setup();
    managed.source.checkPermission = async () => {
      throw problem('permission.unavailable', 503, 'retry');
    };
    const res = await call({
      op: 'checkPermission',
      args: [U1, 'crm', 'read'],
      requestId: 'inv-1',
    });
    expect(res).toMatchObject({ type: 'host:err', status: 503 });
  });
});

describe('worker host call: session', () => {
  it("is the request's own, whatever the worker sent", async () => {
    const { call, managed } = setup();
    managed.invokeTenants.set('inv-2', {
      tenantId: null,
      session: async () => ({ user: { id: U1 } }),
    });
    expect((await call({ op: 'getSession', args: [], requestId: 'inv-2' })).result).toEqual({
      user: { id: U1 },
    });
    expect((await call({ op: 'getSession', args: [] })).result).toBe(null);
  });
});

describe('worker host call: events', () => {
  it("emits only the extension's own events", async () => {
    const { call } = setup();
    const seen: unknown[] = [];
    const off = engineEvents.on('probe.ping' as never, ((p: unknown) => seen.push(p)) as never);
    try {
      expect((await call({ op: 'emit', args: ['probe.ping', { n: 1 }, true] })).type).toBe(
        'host:ok',
      );
      expect(seen).toEqual([{ n: 1 }]);
      for (const event of ['record.created', 'other.ping', 'probeX.ping']) {
        const res = await call({ op: 'emit', args: [event, {}, false] });
        expect(res.type).toBe('host:err');
        expect(res.error).toContain(`may not emit "${event}"`);
      }
    } finally {
      off();
    }
  });

  it('an extension named like an engine namespace still cannot use engine events', async () => {
    const { call } = setup('record', ['user']);
    for (const op of ['emit', 'on']) {
      for (const event of ['record.created', 'user.login']) {
        expect((await call({ op, args: [event, 'k', false] })).type).toBe('host:err');
      }
    }
  });

  it('listens to its own and its declared dependencies, never the engine or a stranger', async () => {
    const { call, managed, host } = setup('probe', ['dep']);
    for (const event of ['probe.ping', 'dep.ping']) {
      expect((await call({ op: 'on', args: [event, event] })).type).toBe('host:ok');
    }
    for (const event of ['record.created', 'stranger.ping']) {
      const res = await call({ op: 'on', args: [event, 'k'] });
      expect(res.error).toContain(`may not listen to "${event}"`);
    }
    const before = engineEvents.listenerCount('dep.ping' as never);
    expect((await call({ op: 'off', args: ['dep.ping'] })).type).toBe('host:ok');
    expect(engineEvents.listenerCount('dep.ping' as never)).toBe(before - 1);
    // Stopping the worker drops what is left.
    (host as unknown as { workers: Map<string, unknown> }).workers.set('probe', managed);
    await host.stop('probe');
    expect(engineEvents.listenerCount('probe.ping' as never)).toBe(0);
  });

  it('refuses an op it does not know', async () => {
    const { call } = setup();
    expect((await call({ op: 'internals', args: [] })).error).toContain('unknown host call');
  });
});

describe('worker route error', () => {
  it('an uncaught SQLSTATE answers as an inline route: 22P02 is 400', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const { managed } = setup();
    managed.routes = [{ method: 'GET', path: '/x' }];
    managed.worker.postMessage = (msg: HostToWorkerMessage) => {
      const cb = managed.pendingInvokes.get((msg as { id: string }).id);
      cb?.({ type: 'route:err', id: (msg as { id: string }).id, error: 'bad', errno: '22P02' });
    };
    (host as unknown as { workers: Map<string, unknown> }).workers.set('probe', managed);
    mountProxy(host, managed as never);
    const res = await app.request('/ext/probe/x');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_parameter');
  });
});

describe('db.transaction() savepoints across extensions', () => {
  const { newRequestTxn, requestSavepoint } = _internalForTests;
  function fakeConn(log: string[]) {
    return {
      unsafe: async (q: string, params?: unknown[]) => {
        log.push(q.trim().split(/\s+/).slice(0, 4).join(' '));
        return q.includes('pg_roles') ? [{ role: `zvx_${String(params?.[0] ?? '')}` }] : [];
      },
      release: () => {},
    };
  }

  it('refuses to end a savepoint another extension opened, and re-sets the role after a rollback', async () => {
    const log: string[] = [];
    const txn = newRequestTxn();
    txn.conn = fakeConn(log) as never;
    txn.ext = 'a';
    const scope = { txn } as never;

    await requestSavepoint('a', scope, 'begin');
    // b runs inside a's savepoint (a service call), then tries to end it.
    await expect(requestSavepoint('b', scope, 'rollback')).rejects.toThrow(
      'no db.transaction() is open',
    );
    expect(txn.savepoints).toEqual(['a']);

    await requestSavepoint('a', scope, 'rollback');
    expect(txn.savepoints).toEqual([]);
    // ROLLBACK TO undid whatever SET LOCAL ROLE came after the savepoint, so the
    // cached role is forgotten and the next statement sets its own.
    expect(txn.ext).toBeUndefined();
    expect(log).toContain('ROLLBACK TO SAVEPOINT zv_sp_1');
  });
});
