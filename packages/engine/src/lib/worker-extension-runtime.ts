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

import { Hono } from 'hono';
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

function send(msg: WorkerToHostMessage): void {
  self.postMessage(msg);
}

function rpcId(prefix: string): string {
  return `${prefix}-${++nextId}`;
}

// Forward console output so operators see worker logs in the engine
// journal. Without this, console.log inside the extension only goes
// to the worker's stdout (which is captured by Bun but not exposed).
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    send({
      type: 'log',
      level,
      message: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    });
  };
}

/**
 * Kysely-style executor that crosses the worker boundary for every query.
 * Returns a CompiledQuery-result-shape object.
 */
async function dbExecute(sql: string, params: unknown[]): Promise<{ rows: unknown[] }> {
  return new Promise((resolve, reject) => {
    const id = rpcId('db');
    pendingDbQueries.set(id, (res) => {
      if (res.type === 'db:ok') {
        resolve({ rows: res.rows ?? [] });
      } else {
        reject(new Error(res.error ?? 'db query failed'));
      }
    });
    send({ type: 'db:query', id, sql, params });
  });
}

/** Service call across the boundary. Stringly-typed by design. */
async function serviceCall(name: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = rpcId('svc');
    pendingServiceCalls.set(id, (res) => {
      if (res.type === 'service:ok') {
        resolve(res.result);
      } else {
        reject(new Error(res.error ?? 'service call failed'));
      }
    });
    send({ type: 'service:call', id, name, args });
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
      query: async <R = unknown>(sql: string, ...params: unknown[]): Promise<R[]> => {
        const r = await dbExecute(sql, params);
        return r.rows as R[];
      },
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

async function handleInit(msg: Extract<HostToWorkerMessage, { type: 'init' }>): Promise<void> {
  try {
    // Worker has no env access by default — the host passes only
    // what's necessary. Set NODE_ENV so frameworks don't assume dev.
    if (msg.env.NODE_ENV) {
      (globalThis as { process?: { env?: Record<string, string> } }).process = {
        env: { NODE_ENV: msg.env.NODE_ENV },
      };
    }
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
    const res = await shadowApp.fetch(req);
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
    const result = await Promise.resolve(impl(...msg.args));
    send({ type: 'service:invoke:ok', id: msg.id, result });
  } catch (err) {
    send({ type: 'service:invoke:err', id: msg.id, error: (err as Error).message });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
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
};
