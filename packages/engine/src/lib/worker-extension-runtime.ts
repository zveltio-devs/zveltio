/**
 * Worker-side runtime for isolated extensions.
 *
 * Runs as its own process — the extension runner's, or a local child of the
 * engine (worker-extension-transport.ts) — speaking frames on stdin/stdout to
 * worker-extension-host.ts. The host sends an `InitRequest` with the bundle URL
 * and the runtime:
 *
 *   1. Dynamically imports the bundle to get the default-exported
 *      `ZveltioExtension`.
 *   2. Constructs a shadow Hono — every route registered against it
 *      lands in `this.routes` rather than mounting at the engine root.
 *   3. Constructs the extension's `ctx` (worker-extension-ctx.ts): the
 *      inline surface, each member a message to the host.
 *   4. Calls `extension.register(shadowApp, shadowCtx)`.
 *   5. Posts the route table back via `InitResponse`.
 *
 * After init, each `RouteInvokeRequest` from the host is dispatched
 * through the shadow Hono (which holds the real handlers). The
 * response is serialized and posted back.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sqlState } from '../db/bun-sql-quirks.js';
import { createSafeFetch } from './edge-functions/safe-fetch.js';
import { buildWorkerCtx } from './worker-extension-ctx.js';
import type {
  HostCallOp,
  HostCallResponse,
  HostToWorkerMessage,
  WorkerToHostMessage,
  RouteDescriptor,
  RouteInvokeRequest,
  DbQueryRequest,
  DbQueryResponse,
  ServiceCallResponse,
  ServiceInvokeRequest,
  ServiceRegisterResponse,
} from './worker-extension-protocol.js';
import { encodeFrame, FrameDecoder } from './worker-extension-transport.js';

let nextId = 0;
const pendingDbQueries = new Map<string, (res: DbQueryResponse) => void>();
/** `service:call` and `host:call`, answered alike. */
const pendingCalls = new Map<string, (res: ServiceCallResponse | HostCallResponse) => void>();
const pendingServiceRegistrations = new Map<string, (res: ServiceRegisterResponse) => void>();

/** Services this worker registered. Host invokes them via service:invoke. */
const localServices = new Map<string, (...args: unknown[]) => unknown>();
/** `ctx.events.on` listeners, by the key the host delivers them under. */
const localListeners = new Map<string, (...args: unknown[]) => unknown>();

/**
 * stdout is the channel. The runtime keeps the only writer to it, and an
 * extension's `process.stdout.write` goes to stderr; a raw write to fd 1 still
 * corrupts the channel, which ends the runner (the host respawns it).
 */
const writeChannel = process.stdout.write.bind(process.stdout);
// Captured before `handleInit` swaps `globalThis.process` for its shim.
const exit = process.exit.bind(process);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

function send(msg: WorkerToHostMessage): void {
  writeChannel(encodeFrame(msg));
}

function rpcId(prefix: string): string {
  return `${prefix}-${++nextId}`;
}

// Forward console output so operators see extension logs in the engine
// journal. `console.log` would write to the channel (stdout): it is only
// forwarded (and `info`/`debug`, which also write to stdout, with it).
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (level !== 'log') orig(...args);
    send({
      type: 'log',
      level,
      // As the console prints it: JSON.stringify made an Error `{}`.
      message: args.map((a) => (typeof a === 'string' ? a : Bun.inspect(a))).join(' '),
    });
  };
}
console.info = console.log;
console.debug = console.log;

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
const invocation = new AsyncLocalStorage<{ id: string; user?: unknown; threw?: boolean }>();

/**
 * The `db.transaction()` callback a statement runs in, by an id minted here. The
 * host decides what it names: inside a request, nothing (the request is the
 * transaction, and a nested callback a savepoint); outside one, a transaction
 * the host opens for this callback alone (owner decision 4).
 */
const transaction = new AsyncLocalStorage<string>();

/** Run a `db.transaction()` callback; one nested in another keeps the outer id. */
function inTransaction<T>(run: () => Promise<T>): Promise<T> {
  return transaction.getStore() ? run() : transaction.run(rpcId('txn'), run);
}

/**
 * A query across the worker boundary, answered in the inline driver's shape:
 * the rows carry the affected-row `count`, and an error its SQLSTATE in `errno`
 * (and the driver's `code`), as Bun.SQL does.
 */
async function dbExecute(
  sql: string,
  params: unknown[],
  savepoint?: DbQueryRequest['savepoint'],
): Promise<unknown[]> {
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
    const requestId = invocation.getStore()?.id;
    const txn = transaction.getStore();
    send({
      type: 'db:query',
      id,
      sql,
      params,
      requestId,
      ...(savepoint ? { savepoint } : {}),
      ...(txn ? { txn } : {}),
    });
  });
}

/** A call the host answers; `send` names the request it serves. */
function call(send: (id: string) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = rpcId('call');
    pendingCalls.set(id, (res) => {
      if (res.type === 'service:ok' || res.type === 'host:ok') {
        resolve(res.result);
      } else if (res.status) {
        // Hono answers an uncaught HTTPException with its own status.
        reject(new HTTPException(res.status as 503, { message: res.error }));
      } else {
        reject(new Error(res.error ?? 'call failed'));
      }
    });
    send(id);
  });
}

/** Service call across the boundary. Stringly-typed by design. */
function serviceCall(name: string, args: unknown[]): Promise<unknown> {
  // The request it serves, as for a query: the host answers the call as that
  // request's tenant, looked up in its own record.
  const requestId = invocation.getStore()?.id;
  return call((id) => send({ type: 'service:call', id, name, args, requestId }));
}

/** A ctx member only the host can answer (worker-extension-ctx.ts). */
function hostCall(op: HostCallOp, args: unknown[]): Promise<unknown> {
  const requestId = invocation.getStore()?.id;
  return call((id) => send({ type: 'host:call', id, op, args, requestId }));
}

function registerService(name: string, impl: (...args: unknown[]) => unknown): void {
  // Bridge through to the host registry — the host wraps this worker so other
  // extensions can call back via service:invoke.
  if (typeof impl !== 'function') {
    throw new Error(`ctx.services.register("${name}"): impl must be a function`);
  }
  localServices.set(name, impl);
  const id = rpcId('reg');
  // Fire-and-forget — register() returns void synchronously in the SDK
  // contract. Failures are surfaced via console; the service simply won't be
  // reachable.
  pendingServiceRegistrations.set(id, (res) => {
    if (res.type === 'service:register:err') {
      console.error(`[worker] failed to register service "${name}" with host: ${res.error}`);
      localServices.delete(name);
    }
  });
  send({ type: 'service:register', id, name });
}

let shadowApp: Hono | null = null;

function collectRoutes(app: Hono): RouteDescriptor[] {
  // Hono v4 exposes `.routes` as an array of { method, path, handler }.
  const out: RouteDescriptor[] = [];
  for (const r of (app as unknown as { routes: { method: string; path: string }[] }).routes) {
    // Middleware (`use`, and the runtime's own below): nothing the host mounts.
    if (r.method !== 'ALL') out.push({ method: r.method, path: r.path });
  }
  return out;
}

/**
 * Route the worker's `fetch` through the engine's SSRF validator.
 *
 * Read the limit first, because the name invites the wrong reading: this is
 * NOT a security boundary, and nothing here contains malicious code. The
 * runtime has the full Node API — `node:http` and `node:net` are one import
 * away, and an extension that wants to reach 169.254.169.254 simply does not
 * call `fetch`. That was measured, not assumed: `Bun.plugin` cannot block
 * builtin imports. Containment against hostile code is the runner's network
 * (`network_mode: none`, `IPAddressDeny=any`), not this.
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
    // process's environment, which the host or the runner sets to NODE_ENV alone,
    // so DATABASE_URL and the engine secrets never reach it.
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
    const app = new Hono();
    // What `c.get('user')` reads inline: the principal the `/ext/*` gate admitted.
    app.use('*', async (c, next) => {
      const store = invocation.getStore();
      if (store?.user) c.set('user' as never, store.user as never);
      await next();
      // Hono rendered a throw: the host rolls the request back, as inline.
      if (c.error && store) store.threw = true;
    });
    app.onError(onRouteError);
    // A router from the extension's own bundled Hono keeps that copy's default
    // handler (the identity check `propagateErrorHandler` in register.ts explains).
    const route = app.route.bind(app);
    app.route = ((path: string, sub: { onError?: (h: typeof onRouteError) => unknown }) => {
      sub?.onError?.(onRouteError);
      return route(path, sub as Hono);
    }) as typeof app.route;
    const { ctx, settled } = buildWorkerCtx({
      query: dbExecute,
      savepoint: (op) => dbExecute('', [], op),
      transaction: inTransaction,
      host: hostCall,
      serviceCall,
      registerService,
      listeners: localListeners,
      config: msg.config,
    });
    await extension.register(app, ctx);
    await settled();
    shadowApp = app;
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

/**
 * An uncaught error carrying a SQLSTATE goes to the host's `problemOnError`, as
 * an inline route's does (22P02 → 400, 55P03 → 503); anything else as Hono's
 * default answers it.
 */
function onRouteError(err: Error, c: Context): Response {
  if (sqlState(err)) throw err;
  if ('getResponse' in err) return (err as HTTPException).getResponse();
  console.error(err);
  return c.text('Internal Server Error', 500);
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
    const store: { id: string; user?: unknown; threw?: boolean } = { id: msg.id, user: msg.user };
    const res = await invocation.run(store, () => app.fetch(req));
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
      ...(store.threw ? { threw: true } : {}),
    });
  } catch (err) {
    const errno = sqlState(err);
    send({
      type: 'route:err',
      id: msg.id,
      error: (err as Error).message,
      ...(errno ? { errno } : {}),
    });
  }
}

async function handleServiceInvoke(msg: ServiceInvokeRequest): Promise<void> {
  const impl = (msg.type === 'event:deliver' ? localListeners : localServices).get(msg.name);
  if (!impl) {
    send({
      type: 'service:invoke:err',
      id: msg.id,
      error: `${msg.type === 'event:deliver' ? 'listener' : 'service'} "${msg.name}" not registered in this worker`,
    });
    return;
  }
  try {
    // The host minted this id as an invocation of its own, recorded under the
    // CALLER's tenant, so the service's queries name it exactly as a route's do.
    const result = await invocation.run({ id: msg.id }, () => Promise.resolve(impl(...msg.args)));
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
    case 'event:deliver':
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
    case 'service:err':
    case 'host:ok':
    case 'host:err': {
      const cb = pendingCalls.get(msg.id);
      if (cb) {
        pendingCalls.delete(msg.id);
        cb(msg);
      }
      break;
    }
  }
}

// The host closing stdin (or dying) ends the runner; a frame the decoder
// refuses means the host is not who is talking, and so does the runner.
void (async () => {
  const frames = new FrameDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    for (const msg of frames.push(chunk)) dispatch(msg as HostToWorkerMessage);
  }
  exit(0);
})().catch(() => exit(1));
