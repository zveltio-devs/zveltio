/**
 * Wire protocol for the worker extension host (C-minimal isolation).
 *
 * One pair of message types per logical call. The host sends `<X>Request`,
 * the worker replies with `<X>Response` keyed by the same `id`. Same
 * shape both directions so structured-clone over postMessage works
 * without serialization helpers.
 *
 * Routes register cross-process: the worker's shadow Hono records the
 * route table, posts it to the host via `RoutesRegistered`. The host
 * then mounts a proxy that, on every HTTP hit, packages the request
 * into `RouteInvokeRequest`, awaits `RouteInvokeResponse`, and writes
 * the worker's response back to the client.
 *
 * DB queries also cross-process: the worker has NO DATABASE_URL; its
 * Kysely instance uses a dialect that posts `DbQueryRequest` and waits
 * for `DbQueryResponse`. The host runs the compiled SQL on the real
 * shared pool. This is the load-bearing security property of the
 * worker mode — untrusted (third-party) extension code never sees DB
 * credentials, never opens its own connections, and the host can
 * audit / rate-limit / scope every query before execution.
 */

export type WorkerMessageId = string;

// ── Lifecycle ───────────────────────────────────────────────────────

export interface InitRequest {
  type: 'init';
  id: WorkerMessageId;
  bundleUrl: string;
  extName: string;
  // Constants the worker needs to render full responses. NEVER include
  // DATABASE_URL or other credentials here — that's the whole point.
  env: {
    NODE_ENV?: string;
    extensionPath: string;
  };
  /** The extension's own `ctx.config`, as `buildRestrictedContext` resolved it inline. */
  config?: unknown;
}

export interface InitResponse {
  type: 'init:ok' | 'init:err';
  id: WorkerMessageId;
  error?: string;
  routes?: RouteDescriptor[];
}

export interface ShutdownRequest {
  type: 'shutdown';
  id: WorkerMessageId;
}

// ── Routes ──────────────────────────────────────────────────────────

export interface RouteDescriptor {
  method: string; // 'GET' | 'POST' | …
  path: string; // Hono pattern e.g. '/contacts/:id'
}

export interface RouteInvokeRequest {
  type: 'route:invoke';
  id: WorkerMessageId;
  method: string;
  path: string; // resolved path (no params)
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: string; // JSON or text; binary not supported in C-minimal
  /**
   * What `c.get('user')` reads inline: the session user or API-key principal
   * the `/ext/*` gate admitted. The worker's handlers see it; the host never
   * reads it back — host calls are answered from its own record of the request.
   */
  user?: unknown;
  tenantId?: string;
}

export interface RouteInvokeResponse {
  type: 'route:ok' | 'route:err';
  id: WorkerMessageId;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  /** The SQLSTATE of an error the handler did not catch, for the host's `problemOnError`. */
  errno?: string;
  /**
   * The handler threw and Hono rendered the error (`c.error`): the host rolls
   * the request's transaction back, as `tenantMiddleware` does inline.
   */
  threw?: boolean;
}

// ── DB ──────────────────────────────────────────────────────────────

export interface DbQueryRequest {
  type: 'db:query';
  id: WorkerMessageId;
  sql: string;
  params: unknown[];
  /**
   * The `route:invoke` this query was issued while handling, if any.
   *
   * The host uses it to look up the tenant IN ITS OWN RECORDS — the id names a
   * request the host dispatched, and the tenant comes from what the host sent,
   * not from anything the worker says. A worker that invents an id gets no
   * tenant context and reads nothing; a worker that names another extension's
   * request does not match, because the map is per worker.
   *
   * Sending the tenant id itself would be simpler and worthless: the worker is
   * the untrusted party here, so a tenant it asserts is a tenant it chose.
   */
  requestId?: WorkerMessageId;
  /**
   * `db.transaction()` (RFC step 8): open, release or roll back a savepoint in
   * the request's transaction, with `sql` empty. The host names the savepoint;
   * the worker never sends transaction-control text.
   */
  savepoint?: 'begin' | 'release' | 'rollback';
}

export interface DbQueryResponse {
  type: 'db:ok' | 'db:err';
  id: WorkerMessageId;
  rows?: unknown[];
  /** Rows the statement affected — what Bun puts on its result array as `count`. */
  count?: number;
  error?: string;
  /** The SQLSTATE, and the driver's code, set on the error the worker rethrows. */
  errno?: string;
  code?: string;
}

// ── Services ────────────────────────────────────────────────────────

export interface ServiceCallRequest {
  type: 'service:call';
  id: WorkerMessageId;
  name: string;
  args: unknown[];
  /**
   * The invocation this call was made while handling, exactly as on
   * `DbQueryRequest`: the host answers the call as the tenant of its own record
   * of that invocation, and refuses an id it no longer holds.
   */
  requestId?: WorkerMessageId;
}

export interface ServiceCallResponse {
  type: 'service:ok' | 'service:err';
  id: WorkerMessageId;
  result?: unknown;
  error?: string;
  /** HTTP status the caller's route answers with if it does not catch (503: dependency down). */
  status?: number;
}

// ── Host calls (worker → host): the ctx members only the host can answer ──

/**
 * `ctx.checkPermission`, `ctx.auth.api.getSession`, `ctx.events.emit|on|off`
 * (RFC extension-runner step 7). Identity is never an argument: the host answers
 * as the request `requestId` names, from its own record of it, as for a query.
 */
export type HostCallOp = 'checkPermission' | 'getSession' | 'emit' | 'on' | 'off';

export interface HostCallRequest {
  type: 'host:call';
  id: WorkerMessageId;
  op: HostCallOp;
  args: unknown[];
  requestId?: WorkerMessageId;
}

export interface HostCallResponse {
  type: 'host:ok' | 'host:err';
  id: WorkerMessageId;
  result?: unknown;
  error?: string;
  /** As on `ServiceCallResponse`: the status a route answers with if it does not catch. */
  status?: number;
}

// ── Log forwarding (worker → host) ──────────────────────────────────

export interface LogMessage {
  type: 'log';
  level: 'log' | 'warn' | 'error';
  message: string;
}

// ── Heartbeat (host → worker → host) ────────────────────────────────

export interface PingRequest {
  type: 'ping';
  id: WorkerMessageId;
}

export interface PongResponse {
  type: 'pong';
  id: WorkerMessageId;
}

// ── Service registry bridge (worker A → host → worker B / inline) ───

export interface ServiceRegisterRequest {
  type: 'service:register';
  id: WorkerMessageId;
  name: string;
}

export interface ServiceRegisterResponse {
  type: 'service:register:ok' | 'service:register:err';
  id: WorkerMessageId;
  error?: string;
}

/**
 * Host → worker: invoke a service that this worker previously registered.
 *
 * `id` doubles as an invocation the host records under the CALLER's tenant for
 * as long as the call is pending; the worker runs the service under it, so the
 * service's queries and calls name it as `requestId`.
 */
export interface ServiceInvokeRequest {
  /** `event:deliver`: an event the worker subscribed to with `ctx.events.on`, `name` its listener. */
  type: 'service:invoke' | 'event:deliver';
  id: WorkerMessageId;
  name: string;
  args: unknown[];
}

export interface ServiceInvokeResponse {
  type: 'service:invoke:ok' | 'service:invoke:err';
  id: WorkerMessageId;
  result?: unknown;
  error?: string;
}

// ── Union ───────────────────────────────────────────────────────────

export type HostToWorkerMessage =
  | InitRequest
  | ShutdownRequest
  | RouteInvokeRequest
  | DbQueryResponse
  | ServiceCallResponse
  | PingRequest
  | ServiceRegisterResponse
  | ServiceInvokeRequest
  | HostCallResponse;

export type WorkerToHostMessage =
  | InitResponse
  | RouteInvokeResponse
  | DbQueryRequest
  | ServiceCallRequest
  | LogMessage
  | PongResponse
  | ServiceRegisterRequest
  | ServiceInvokeResponse
  | HostCallRequest;
