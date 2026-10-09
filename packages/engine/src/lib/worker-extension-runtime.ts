/**
 * Worker-side runtime for isolated extensions.
 *
 * Bootstrapped via `new Worker(<this file URL>, { type: 'module' })` from
 * worker-extension-host.ts. The host then sends an `InitRequest` with
 * the bundle URL and the worker:
 *
 *   1. Dynamically imports the bundle to get the default-exported
 *      `ZveltioExtension`.
 *   2. Constructs a shadow Hono — every route registered against it
 *      lands in `this.routes` rather than mounting at the engine root.
 *   3. Constructs a shadow `ExtensionContext` whose `db` and `services`
 *      proxy each call back to the host via postMessage.
 *   4. Calls `extension.register(shadowApp, shadowCtx)`.
 *   5. Posts the route table back via `InitResponse`.
 *
 * After init, each `RouteInvokeRequest` from the host is dispatched
 * through the shadow Hono (which holds the real handlers). The
 * response is serialized and posted back.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createSafeFetch } from './edge-functions/safe-fetch.js';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
  RouteDescriptor,
  RouteInvokeRequest,
  DbQueryResponse,
  ServiceCallResponse,
  ServiceInvokeRequest,
  ServiceRegisterResponse,
} from './worker-extension-protocol.js';
import { encodeFrame, FrameDecoder } from './worker-extension-transport.js';

declare const self: {
  postMessage: (msg: WorkerToHostMessage) => void;
  onmessage: ((e: MessageEvent<HostToWorkerMessage>) => void) | null;
};

let nextId = 0;
const pendingDbQueries = new Map<string, (res: DbQueryResponse) => void>();
const pendingServiceCalls = new Map<string, (res: ServiceCallResponse) => void>();
const pendingServiceRegistrations = new Map<string, (res: ServiceRegisterResponse) => void>();

/** Services this worker registered. Host invokes them via service:invoke. */
const localServices = new Map<string, (...args: unknown[]) => unknown>();

/**
 * In a worker thread the host talks through `postMessage`; as a runner process
 * (`ZVELTIO_EXT_TRANSPORT=process`) through frames on stdin and stdout.
 */
const asProcess = Bun.isMainThread;

/**
 * stdout is the channel. The runtime keeps the only writer to it, and an
 * extension's `process.stdout.write` goes to stderr; a raw write to fd 1 still
 * corrupts the channel, which ends the runner (the host respawns it).
 */
const writeChannel = asProcess ? process.stdout.write.bind(process.stdout) : null;
// Captured before `handleInit` swaps `globalThis.process` for its shim.
const exit = process.exit.bind(process);
if (asProcess) {
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
}

function send(msg: WorkerToHostMessage): void {
  if (writeChannel) writeChannel(encodeFrame(msg));
  else self.postMessage(msg);
}

function rpcId(prefix: string): string {
  return `${prefix}-${++nextId}`;
}

// Forward console output so operators see worker logs in the engine
// journal. Without this, console.log inside the extension only goes
// to the worker's stdout (which is captured by Bun but not exposed).
// As a runner process `console.log` would write to the channel: it is only
// forwarded (and `info`/`debug`, which also write to stdout, with it).
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (!asProcess || level !== 'log') orig(...args);
    send({
      type: 'log',
      level,
      // As the console prints it: JSON.stringify made an Error `{}`.
      message: args.map((a) => (typeof a === 'string' ? a : Bun.inspect(a))).join(' '),
    });
  };
}
if (asProcess) {
  console.info = console.log;
  console.debug = console.log;
}

/**
 * The route invocation a piece of work belongs to — the host's id for the
 * request, or for a `service:invoke` the host sent on a caller's behalf. A
 * query or service call names it, and the host reads the tenant from its OWN
 * record of the invocation (`invokeTenants`), never from anything the worker
 * says about it. Work that outlives the request still carries the id;
 * the host refuses it, since the record is gone.
 *
 * The protocol always had the field and the host always looked it up; this side
 * never sent it, so every worker query ran with no tenant.
 */
const invocation = new AsyncLocalStorage<string>();

/**
 * A query across the worker boundary, answered in the inline driver's shape:
 * the rows carry the affected-row `count`, and an error its SQLSTATE in `errno`
 * (and the driver's `code`), as Bun.SQL does.
 */
async function dbExecute(sql: string, params: unknown[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const id = rpcId('db');
    pendingDbQueries.set(id, (res) => {
      if (res.type === 'db:ok') {
        const rows = res.rows ?? [];
        resolve(res.count === undefined ? rows : Object.assign(rows, { count: res.count }));
      } else {
        const { errno, code } = res;
        reject(
          Object.assign(new Error(res.error ?? 'db query failed'), errno ? { errno, code } : {}),
        );
      }
    });
    send({ type: 'db:query', id, sql, params, requestId: invocation.getStore() });
  });
}

/** Service call across the boundary. Stringly-typed by design. */
async function serviceCall(name: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = rpcId('svc');
    pendingServiceCalls.set(id, (res) => {
      if (res.type === 'service:ok') {
        resolve(res.result);
      } else if (res.status) {
        // Hono answers an uncaught HTTPException with its own status.
        reject(new HTTPException(res.status as 503, { message: res.error }));
      } else {
        reject(new Error(res.error ?? 'service call failed'));
      }
    });
    // The request it serves, as for a query: the host answers the call as that
    // request's tenant, looked up in its own record.
    send({ type: 'service:call', id, name, args, requestId: invocation.getStore() });
  });
}

/**
 * Build a minimal ExtensionContext shape that proxies to the host.
 * Extension code sees a normal-looking ctx; under the hood every
 * db/services call crosses IPC.
 */
function buildShadowCtx() {
  // We deliberately don't ship a full Kysely instance here — most
  // worker-mode extensions interact via raw SQL through ctx.db.raw()
  // or through services published by other extensions. A future
  // iteration can wire a Kysely proxy dialect on top of dbExecute.
  return {
    db: {
      // Raw query helper for extensions that build SQL themselves.
      query: <R = unknown>(sql: string, ...params: unknown[]): Promise<R[]> =>
        dbExecute(sql, params) as Promise<R[]>,
    },
    services: {
      register: (name: string, impl: (...args: unknown[]) => unknown): void => {
        // Bridge through to the host registry — the host wraps this
        // worker so other extensions can call back via service:invoke.
        if (typeof impl !== 'function') {
          throw new Error(`ctx.services.register("${name}"): impl must be a function`);
        }
        localServices.set(name, impl);
        const id = rpcId('reg');
        // Fire-and-forget — register() returns void synchronously in
        // the SDK contract. Failures are surfaced via console; the
        // service simply won't be reachable.
        pendingServiceRegistrations.set(id, (res) => {
          if (res.type === 'service:register:err') {
            console.error(`[worker] failed to register service "${name}" with host: ${res.error}`);
            localServices.delete(name);
          }
        });
        send({ type: 'service:register', id, name });
      },
      get: serviceCall,
    },
  };
}

let shadowApp: Hono | null = null;

function collectRoutes(app: Hono): RouteDescriptor[] {
  // Hono v4 exposes `.routes` as an array of { method, path, handler }.
  const out: RouteDescriptor[] = [];
  for (const r of (app as unknown as { routes: { method: string; path: string }[] }).routes) {
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

/**
 * Route the worker's `fetch` through the engine's SSRF validator.
 *
 * Read the limit first, because the name invites the wrong reading: this is
 * NOT a security boundary, and nothing here contains malicious code. A
 * Bun.Worker is a thread with the full Node API — `node:http` and `node:net`
 * are one import away, and an extension that wants to reach 169.254.169.254
 * simply does not call `fetch`. That was measured, not assumed: `Bun.plugin`
 * cannot block builtin imports, and a probe read `/etc/hostname` from inside
 * a worker. Containment against hostile code needs WASM or OS-level process
 * isolation; see the WASM decision note.
 *
 * What it does buy, and the reason it ships: an extension that takes a URL
 * from its own configuration and fetches it — a webhook target, an API base
 * URL, an avatar — stops being an SSRF pivot into the operator's private
 * network by accident. That is the common case and it is worth closing.
 *
 * Scope is narrow by construction. Only `isolation: "worker"` extensions run
 * here, which today is the third-party/community tier and nothing else. The
 * first-party extensions that legitimately talk to loopback services (Ollama,
 * SeaweedFS) load inline and never reach this code, so the guard cannot break
 * them. ZVELTIO_WORKER_ALLOW_PRIVATE_FETCH=1 lifts it for an operator running
 * a worker extension against a deliberately internal endpoint.
 */
function installFetchGuard(): void {
  if (process.env.ZVELTIO_WORKER_ALLOW_PRIVATE_FETCH === '1') return;
  const original = globalThis.fetch;
  // The engine's own safeFetch, not a check in front of the real fetch: a check
  // in front let the real fetch follow redirects, so a configured public URL
  // that 302'd to 169.254.169.254 was fetched anyway.
  const guarded = createSafeFetch(() => original);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    guarded(input, init)) as typeof fetch;
}

async function handleInit(msg: Extract<HostToWorkerMessage, { type: 'init' }>): Promise<void> {
  try {
    // Convenience only — NOT the boundary. This assignment is reachable through
    // `globalThis.process`, but `await import('node:process')` bypasses it
    // entirely, so on its own it kept nothing out. The real restriction is the
    // `env` option the host passes to the Worker constructor, which is what
    // actually stops the extension seeing DATABASE_URL and the engine secrets.
    if (msg.env.NODE_ENV) {
      (globalThis as { process?: { env?: Record<string, string> } }).process = {
        env: { NODE_ENV: msg.env.NODE_ENV },
      };
    }
    installFetchGuard();
    const module = await import(msg.bundleUrl);
    const extension = module.default;
    if (!extension || typeof extension.register !== 'function') {
      send({
        type: 'init:err',
        id: msg.id,
        error: 'bundle has no default export with a register() function',
      });
      return;
    }
    shadowApp = new Hono();
    await extension.register(shadowApp, buildShadowCtx());
    send({
      type: 'init:ok',
      id: msg.id,
      routes: collectRoutes(shadowApp),
    });
  } catch (err) {
    send({
      type: 'init:err',
      id: msg.id,
      error: (err as Error).message,
    });
  }
}

async function handleRouteInvoke(msg: RouteInvokeRequest): Promise<void> {
  if (!shadowApp) {
    send({ type: 'route:err', id: msg.id, error: 'worker not initialized' });
    return;
  }
  try {
    // Reconstruct a fetch Request the shadow Hono can dispatch.
    const url = new URL(`http://worker.local${msg.path}`);
    for (const [k, v] of Object.entries(msg.query)) {
      url.searchParams.set(k, v);
    }
    const req = new Request(url.toString(), {
      method: msg.method,
      headers: msg.headers,
      body: msg.body,
    });
    const app = shadowApp;
    const res = await invocation.run(msg.id, () => app.fetch(req));
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    send({
      type: 'route:ok',
      id: msg.id,
      status: res.status,
      headers,
      body,
    });
  } catch (err) {
    send({ type: 'route:err', id: msg.id, error: (err as Error).message });
  }
}

async function handleServiceInvoke(msg: ServiceInvokeRequest): Promise<void> {
  const impl = localServices.get(msg.name);
  if (!impl) {
    send({
      type: 'service:invoke:err',
      id: msg.id,
      error: `service "${msg.name}" not registered in this worker`,
    });
    return;
  }
  try {
    // The host minted this id as an invocation of its own, recorded under the
    // CALLER's tenant, so the service's queries name it exactly as a route's do.
    const result = await invocation.run(msg.id, () => Promise.resolve(impl(...msg.args)));
    send({ type: 'service:invoke:ok', id: msg.id, result });
  } catch (err) {
    send({ type: 'service:invoke:err', id: msg.id, error: (err as Error).message });
  }
}

function dispatch(msg: HostToWorkerMessage): void {
  switch (msg.type) {
    case 'init':
      void handleInit(msg);
      break;
    case 'route:invoke':
      void handleRouteInvoke(msg);
      break;
    case 'shutdown':
      // Bun shuts the worker down when the host calls .terminate();
      // this is just for clean intent. No-op here.
      break;
    case 'ping':
      // Heartbeat — reply immediately. Host respawns us if it doesn't
      // get a pong within 60s of any ping.
      send({ type: 'pong', id: msg.id });
      break;
    case 'service:invoke':
      void handleServiceInvoke(msg);
      break;
    case 'service:register:ok':
    case 'service:register:err': {
      const cb = pendingServiceRegistrations.get(msg.id);
      if (cb) {
        pendingServiceRegistrations.delete(msg.id);
        cb(msg);
      }
      break;
    }
    case 'db:ok':
    case 'db:err': {
      const cb = pendingDbQueries.get(msg.id);
      if (cb) {
        pendingDbQueries.delete(msg.id);
        cb(msg);
      }
      break;
    }
    case 'service:ok':
    case 'service:err': {
      const cb = pendingServiceCalls.get(msg.id);
      if (cb) {
        pendingServiceCalls.delete(msg.id);
        cb(msg);
      }
      break;
    }
  }
}

if (asProcess) {
  // The host closing stdin (or dying) ends the runner; a frame the decoder
  // refuses means the host is not who is talking, and so does the runner.
  void (async () => {
    const frames = new FrameDecoder();
    for await (const chunk of Bun.stdin.stream()) {
      for (const msg of frames.push(chunk)) dispatch(msg as HostToWorkerMessage);
    }
    exit(0);
  })().catch(() => exit(1));
} else {
  self.onmessage = (e) => dispatch(e.data);
}
