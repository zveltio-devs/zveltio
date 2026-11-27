/**
 * Worker-side runtime for isolated extensions.
 *
 * Runs as its own process — the extension runner's, or a local child of the
 * engine (worker-extension-transport.ts) — speaking frames on stdin/stdout to
 * worker-extension-host.ts. Every worker is declared model only (ADR 0056,
 * amendment 2026-11-21; RFC v3 phase D slice 4). On `init` the runtime:
 *
 *   1. Imports the bundle's default-exported `ZveltioExtension`.
 *   2. Pairs the manifest's routes and actions with the module's `routes` and
 *      `actions`, and mounts the routes on the router it serves the host from.
 *   3. Calls `register()` with an app and a ctx that refuse every use, so one
 *      that registers anything fails the load, with the reason.
 *
 * After init, a `route:invoke` runs a declared route and an `action:invoke` a
 * declared action; their `host` calls are `host:call` frames the host answers.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mountDeclaredRoutes, pairRouteHandlers } from './declared-routes.js';
import type { DeclaredRouteHost, SignInResult } from '@zveltio/sdk/extension';
import type {
  ActionInvokeRequest,
  ActionInvokeResponse,
  HostCallOp,
  HostCallResponse,
  HostToWorkerMessage,
  WorkerToHostMessage,
  RouteInvokeRequest,
} from './worker-extension-protocol.js';
import { encodeFrame, FrameDecoder } from './worker-extension-transport.js';

let nextId = 0;
const pendingCalls = new Map<string, (res: HostCallResponse) => void>();
/** The module's actions the manifest declares (ADR 0056), paired at init. */
const localActions = new Map<string, (input: unknown, host: unknown) => unknown>();

/**
 * stdout is the channel. The runtime keeps the only writer to it, and an
 * extension's `process.stdout.write` goes to stderr; a raw write to fd 1 still
 * corrupts the channel, which ends the runner (the host respawns it).
 */
const writeChannel = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

function send(msg: WorkerToHostMessage): void {
  writeChannel(encodeFrame(msg));
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
 * The invocation a `host` call belongs to: the host's id for the route request
 * or action run. The host answers the call as its OWN record of that
 * invocation, never as anything the worker says about it; work that outlives
 * the invocation still carries the id, and the host refuses it.
 */
const invocation = new AsyncLocalStorage<{
  id: string;
  threw?: boolean;
  /** The URL the caller sent (a route's), for a declared route's `request.url`. */
  url?: string;
}>();

/** A `host` member only the host can answer, as the invocation it is made in. */
function hostCall(op: HostCallOp, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `call-${++nextId}`;
    pendingCalls.set(id, (res) => {
      if (res.type === 'host:ok') {
        resolve(res.result);
      } else if (res.status) {
        // Hono answers an uncaught HTTPException with its own status. `callId`
        // names the refusal, so an action that lets it through answers the host's own.
        reject(
          Object.assign(new HTTPException(res.status as 503, { message: res.error }), {
            callId: id,
            ...(res.code ? { code: res.code } : {}),
          }),
        );
      } else {
        reject(new Error(res.error ?? 'call failed'));
      }
    });
    send({ type: 'host:call', id, op, args, requestId: invocation.getStore()?.id });
  });
}

/** `host.collections` over `call`, as `ActionHost` and `RouteHost` name it. */
function collectionsVia(
  call: (member: string, ...args: unknown[]) => Promise<unknown>,
): DeclaredRouteHost['collections'] {
  // The host answers each with what the inline member returns.
  const answer = call as (member: string, ...args: unknown[]) => Promise<never>;
  return {
    read: (collection: string, id: string) => answer('collections.read', collection, id),
    list: (collection: string, query?: unknown) =>
      answer('collections.list', collection, query ?? {}),
    insert: (collection: string, data: unknown) => answer('collections.insert', collection, data),
    update: (collection: string, id: string, data: unknown, options?: unknown) =>
      answer('collections.update', collection, id, data, options ?? {}),
    delete: async (collection: string, id: string) => {
      await answer('collections.delete', collection, id);
    },
  };
}

/** `host.identity` over `call` (ADR 0039 d7, d9): the host answers each as inline. */
function identityVia(
  call: (member: string, ...args: unknown[]) => Promise<unknown>,
): NonNullable<DeclaredRouteHost['identity']> {
  const answer = call as (member: string, ...args: unknown[]) => Promise<never>;
  return {
    signIn: async (input) => {
      // Its headers cross as their entries: a `Headers` does not survive the channel.
      const { user, headers } = (await call('signIn', input)) as {
        user: SignInResult['user'];
        headers: [string, string][];
      };
      return { user, headers: new Headers(headers) };
    },
    signInRefused: (input) => answer('signInRefused', input),
    provision: (input) => answer('provision', input),
    update: (subject, patch) => answer('update', subject, patch),
    setActive: (subject, active) => answer('setActive', subject, active),
    remove: (subject) => answer('remove', subject),
    list: (query) => answer('list', ...(query === undefined ? [] : [query])),
    get: (subject) => answer('get', subject),
  };
}

let router: Hono | null = null;

/** What a third-party route or action's `fetch` rejects with. */
const NO_EGRESS_MESSAGE =
  'Third-party extension routes and actions have no network egress (ADR 0022). ' +
  'Enqueue a job that declares `egress` and let the job make the call.';

/**
 * Refuse `fetch` in a worker-isolated extension: its routes and actions have
 * no egress (ADR 0022, Consequences). Network work goes to a job, which the
 * engine fetches for, per consented authority.
 *
 * Read the limit first: this is NOT the boundary. The runtime has the full
 * Node API — `node:net` and `node:http` are one import away, and `Bun.fetch`
 * cannot be replaced (a readonly, unconfigurable property). The boundary is
 * the runner's network: `network_mode: none` in containers, `IPAddressDeny=any`
 * on systemd. In the process backend (single-container PaaS) there is no OS
 * rule, and this refusal is all there is — the known gap the ADR records.
 *
 * What it buys: an extension that calls `fetch` learns at once, with the
 * reason, instead of a timeout from a runner with no address. Only
 * `isolation: "worker"` extensions run here — the third-party tier; first-party
 * extensions load inline and never reach this code.
 */
function refuseFetch(): void {
  globalThis.fetch = (() =>
    Promise.reject(new Error(NO_EGRESS_MESSAGE))) as unknown as typeof fetch;
}

/**
 * ADR 0056 d1: a signed bundle is imported from the bytes the engine sent in
 * `init`, and only when they hash to what its signature lists. The process
 * reads no extension file (ADR 0062 probe "security", F15): on the runner it
 * cannot see the extensions' directory at all, its own included.
 */
function verifiedBundle(bytes: Uint8Array, sha256: string): string {
  const got = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (got !== sha256) {
    throw new Error(`its bundle is not what its signature lists (sha256 ${got}, signed ${sha256})`);
  }
  return URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'text/javascript' }),
  );
}

/**
 * Declared model only (ADR 0056 d1, amendment 2026-11-21; RFC v3 phase D slice
 * 4): `register()` is handed an app and a ctx that refuse every use, so
 * whatever it would register fails the load, with the reason.
 */
function refusing(what: 'app' | 'ctx'): never {
  return new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(
          `register() used ${what}.${String(key)}: a worker-isolated extension is declared ` +
            'model only — collections, actions, jobs, declared routes (ADR 0056). ' +
            'Move it into a declared action, job or route.',
        );
      },
    },
  ) as never;
}

async function handleInit(msg: Extract<HostToWorkerMessage, { type: 'init' }>): Promise<void> {
  try {
    // NODE_ENV on the real `process`, not a `{ env }` object swapped in for it.
    // The swap kept nothing out (the host or the runner already gives this
    // process an environment of NODE_ENV alone, so DATABASE_URL and the engine
    // secrets never reach it), and it broke Bun: `await import('node:process')`
    // after it crashed the worker (ProcessNextTick undefined, core dump).
    if (msg.env.NODE_ENV) process.env.NODE_ENV = msg.env.NODE_ENV;
    refuseFetch();
    const module = await import(verifiedBundle(msg.bundle, msg.bundleSha256));
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
    app.use('*', async (c, next) => {
      await next();
      // Hono rendered a throw: the host rolls the request back, as inline.
      const store = invocation.getStore();
      if (c.error && store) store.threw = true;
    });
    app.onError(onRouteError);
    // ADR 0039: the declared routes, served with the caller's URL, not this app's.
    const declared = pairRouteHandlers(msg.routes ?? [], extension.routes, (why) => {
      throw new Error(why);
    });
    // `host.collections` as the request's caller, and `host.identity` as an inline
    // route's; no files, no enqueue (no `ctx.internals`).
    const routeHost = {
      collections: collectionsVia((member, ...args) => hostCall('collections', [member, ...args])),
      identity: identityVia((member, ...args) => hostCall('identity', [member, ...args])),
    };
    mountDeclaredRoutes(
      app,
      declared,
      () => routeHost,
      (c) => new Request(invocation.getStore()?.url ?? c.req.url, c.req.raw),
    );
    // ADR 0056: each declared action implemented, and nothing implemented undeclared.
    const actions = (extension.actions ?? {}) as Record<string, unknown>;
    for (const name of msg.actions ?? []) {
      const run = Object.hasOwn(actions, name) ? actions[name] : undefined;
      if (typeof run !== 'function') {
        throw new Error(`manifest action "${name}" has no implementation`);
      }
      localActions.set(name, run as (input: unknown, host: unknown) => unknown);
    }
    for (const name of Object.keys(actions)) {
      if (!localActions.has(name)) {
        throw new Error(`action "${name}" is implemented but not declared in the manifest`);
      }
    }
    await extension.register(refusing('app'), refusing('ctx'));
    router = app;
    send({ type: 'init:ok', id: msg.id });
  } catch (err) {
    send({
      type: 'init:err',
      id: msg.id,
      error: (err as Error).message,
    });
  }
}

/**
 * An uncaught error answers as Hono's default does. No SQLSTATE crosses: no SQL
 * runs in a worker, so a code on its error is one it made up (RFC v3 phase D
 * slice 4).
 */
function onRouteError(err: Error, c: Context): Response {
  if ('getResponse' in err) return (err as HTTPException).getResponse();
  console.error(err);
  return c.text('Internal Server Error', 500);
}

async function handleRouteInvoke(msg: RouteInvokeRequest): Promise<void> {
  if (!router) {
    send({ type: 'route:err', id: msg.id, error: 'worker not initialized' });
    return;
  }
  try {
    // Reconstruct a fetch Request the router can dispatch.
    const url = new URL(`http://worker.local${msg.path}`);
    for (const [k, v] of Object.entries(msg.query)) {
      url.searchParams.set(k, v);
    }
    const req = new Request(url.toString(), {
      method: msg.method,
      headers: msg.headers,
      body: msg.body,
    });
    const app = router;
    const store: { id: string; threw?: boolean; url?: string } = { id: msg.id, url: msg.url };
    const res = await invocation.run(store, () => app.fetch(req));
    // Bytes, not text: a binary answer (a PDF, an image) crosses unchanged.
    const body = new Uint8Array(await res.arrayBuffer());
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
    send({ type: 'route:err', id: msg.id, error: (err as Error).message });
  }
}

async function handleActionInvoke(msg: ActionInvokeRequest): Promise<void> {
  const run = localActions.get(msg.name);
  if (!run) {
    send({
      type: 'action:err',
      id: msg.id,
      error: `action "${msg.name}" not registered in this worker`,
    });
    return;
  }
  try {
    // The host minted this id as an invocation of its own, recorded under the
    // caller's tenant and transaction, so the action's `host` calls name it.
    const result = await invocation.run({ id: msg.id }, () =>
      Promise.resolve(run(msg.args[0], actionHost(String(msg.args[1])))),
    );
    send({ type: 'action:ok', id: msg.id, result });
  } catch (err) {
    send({
      type: 'action:err',
      id: msg.id,
      error: (err as Error)?.message ?? String(err),
      ...actionFailure(err),
    });
  }
}

/**
 * An action's `host` (ADR 0056): every member a `host:call` the host answers
 * with the `ActionHost` it built for this invocation, as inline.
 */
function actionHost(timezone: string): unknown {
  const call = (member: string, ...args: unknown[]) => hostCall('action', [member, ...args]);
  return {
    timezone,
    collections: collectionsVia(call),
    enqueue: (job: string, input: unknown, options?: unknown) =>
      call('enqueue', job, input, ...(options === undefined ? [] : [options])),
    actions: {
      run: (extension: string, action: string, input: unknown) =>
        call('actions.run', extension, action, input),
    },
    files: {
      read: (id: string) => call('files.read', id),
      put: (bytes: Uint8Array, options?: unknown) =>
        call('files.put', bytes, ...(options === undefined ? [] : [options])),
    },
  };
}

const ACTION_REFUSAL = Symbol.for('zveltio.extension.action-refusal');

/**
 * Why an action failed, as fields the host can act on: the `ActionRefusal`
 * mark does not cross the channel, and a refusal the host answered one of its
 * calls with is named by that call, so the host rethrows its own.
 */
function actionFailure(err: unknown): Partial<ActionInvokeResponse> {
  const e = (err ?? {}) as Record<string | symbol, unknown>;
  if (typeof e.callId === 'string') return { hostError: e.callId };
  if (e[ACTION_REFUSAL] === true) {
    const message = typeof e.message === 'string' ? e.message : undefined;
    return { refusal: { status: e.status, code: e.code, message } };
  }
  return {};
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
    case 'action:invoke':
      void handleActionInvoke(msg);
      break;
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
