// The host side of a worker's `host:call`: answered from the host's own record
// of the invocation it names — never from anything the worker says about who it
// is, which tenant it serves or which extension it is — and only for what a
// declared route or action may call.
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
} from '../../lib/worker-extension-protocol.js';
import { problem } from '../../lib/problem.js';
import { WorkerExtensionHost, _internalForTests } from '../../lib/worker-extension-host.js';

const { dispatchMessage, mountProxy } = _internalForTests;
const U1 = 'user-1';

function setup(name = 'probe') {
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
    source: {
      collections: async (...args: unknown[]): Promise<unknown> => {
        checks.push(args);
        return { answered: args[1] };
      },
    },
    proxyUnmount: () => {},
    stopped: false,
  };
  // The host's record of a request it dispatched for U1.
  managed.invokeTenants.set('inv-1', { tenantId: null });
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

describe('worker host call: declared model only (RFC v3 phase D slice 4, S2)', () => {
  // The test override's unsigned worker is the one `setup` builds: no key id,
  // no registry key. It used to be served every op below with the inline
  // extension's own answers; now no worker, signed or not, is.
  const OFF_MODEL = [
    ['checkPermission', [U1, 'crm', 'read']],
    ['getUserRoles', [U1]],
    ['getSession', []],
    ['emit', ['probe.ping', {}, true]],
    ['on', ['probe.ping', 'l1']],
    ['off', ['l1']],
    ['waitForService', ['probe.x', 10]],
    ['unregisterService', ['probe.x']],
    ['describeDenial', ['crm', 'read']],
    ['internals', []],
  ] as const;
  for (const [op, args] of OFF_MODEL) {
    it(`refuses ${op} from an unsigned worker, asking nothing inline`, async () => {
      const { call, checks } = setup();
      const res = await call({ op, args, requestId: 'inv-1' });
      expect(res.type).toBe('host:err');
      expect(res.error).toContain('declared model only');
      expect(checks).toEqual([]);
    });
  }

  it("answers a route's host.collections from the host's record of its request", async () => {
    const { call, managed, checks } = setup();
    const c = { req: 'the request' };
    managed.invokeTenants.set('inv-r', { tenantId: null, route: { extName: 'probe', c } });
    const res = await call({
      op: 'collections',
      args: ['collections.read', 'items', '1'],
      requestId: 'inv-r',
    });
    expect(res).toEqual({ type: 'host:ok', id: 'c1', result: { answered: 'collections.read' } });
    expect(checks).toEqual([[c, 'collections.read', ['items', '1']]]);
  });

  it('refuses host.collections outside a route request of this extension', async () => {
    const { call, managed } = setup();
    managed.invokeTenants.set('inv-o', { tenantId: null, route: { extName: 'other', c: {} } });
    for (const requestId of [undefined, 'inv-1', 'inv-o']) {
      const res = await call({ op: 'collections', args: ['collections.read', 'x', '1'], requestId });
      expect(res.type).toBe('host:err');
      expect(res.error).toContain('answers only in a route request of this extension');
    }
  });

  it('refuses a request id the host never issued, or that is over', async () => {
    const { call } = setup();
    const res = await call({
      op: 'collections',
      args: ['collections.read', 'x', '1'],
      requestId: 'inv-x',
    });
    expect(res.type).toBe('host:err');
    expect(res.error).toContain('is over (or was never issued)');
  });

  it('carries the status of a refusal, as inline problemOnError would answer it', async () => {
    const { call, managed } = setup();
    managed.invokeTenants.set('inv-r', { tenantId: null, route: { extName: 'probe', c: {} } });
    managed.source.collections = async () => {
      throw problem('permission.unavailable', 503, 'retry');
    };
    const res = await call({
      op: 'collections',
      args: ['collections.list', 'x', {}],
      requestId: 'inv-r',
    });
    expect(res).toMatchObject({ type: 'host:err', status: 503 });
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

describe('worker route path', () => {
  it('a percent-encoded extension name still strips the /ext/<name> prefix', async () => {
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const { managed } = setup();
    managed.routes = [{ method: 'GET', path: '/x' }];
    let seen: unknown;
    managed.worker.postMessage = (msg: HostToWorkerMessage) => {
      seen = (msg as { path?: unknown }).path;
      const cb = managed.pendingInvokes.get((msg as { id: string }).id);
      cb?.({ type: 'route:err', id: (msg as { id: string }).id, error: 'bad', errno: '22P02' });
    };
    (host as unknown as { workers: Map<string, unknown> }).workers.set('probe', managed);
    mountProxy(host, managed as never);
    await app.request('/ext/%70robe/x');
    expect(seen).toBe('/x');
  });
});

describe('worker route body past the frame limit', () => {
  it('answers 413 and leaves no pending invoke behind', async () => {
    const { FrameTooLargeError } = await import('../../lib/worker-extension-transport.js');
    const app = new Hono();
    const host = new WorkerExtensionHost(app);
    const { managed } = setup();
    managed.routes = [{ method: 'POST', path: '/x' }];
    managed.worker.postMessage = () => {
      throw new FrameTooLargeError('frame of 40000000 bytes exceeds 33554432');
    };
    (host as unknown as { workers: Map<string, unknown> }).workers.set('probe', managed);
    mountProxy(host, managed as never);
    const res = await app.request('/ext/probe/x', { method: 'POST', body: 'x' });
    expect(res.status).toBe(413);
    expect(managed.pendingInvokes.size).toBe(0);
  });
});
