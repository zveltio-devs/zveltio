/**
 * Wire protocol between the worker extension host and the runtime of one
 * worker-isolated extension's process.
 *
 * One pair of message types per logical call. The host sends `<X>Request`,
 * the worker replies with `<X>Response` keyed by the same `id`.
 *
 * Every worker is declared model only (ADR 0056, amendment 2026-11-21; RFC v3
 * phase D slice 4): the protocol carries a declared route (`route:invoke`), a
 * declared action (`action:invoke`) and the `host` calls those two make
 * (`host:call`). Nothing else crosses: no SQL, no service registry, no event
 * bus. The worker never sees DATABASE_URL or any other credential.
 */

export type WorkerMessageId = string;

// ── Lifecycle ───────────────────────────────────────────────────────

export interface InitRequest {
  type: 'init';
  id: WorkerMessageId;
  /**
   * The bundle's bytes, read and checked by the engine. The process never reads
   * extension files: on the runner the extensions' directory is closed to it
   * (ADR 0062 probe "security", F15).
   */
  bundle: Uint8Array;
  /**
   * The bundle's sha256 as its signature lists it — an operator's or the
   * registry's (ADR 0056 d1): the worker imports `bundle` only if it hashes to
   * this. Always sent: no worker runs unsigned.
   */
  bundleSha256: string;
  extName: string;
  // Constants the worker needs. NEVER include DATABASE_URL or other
  // credentials here — that's the whole point.
  env: {
    NODE_ENV?: string;
  };
  /** Its manifest `routes` (ADR 0039), paired with the module's `routes` handlers and served. */
  routes?: { method: string; path: string; handler: string }[];
  /** Its manifest `actions`, by name (ADR 0056): paired with the module's `actions`, run on `action:invoke`. */
  actions?: string[];
}

export interface InitResponse {
  type: 'init:ok' | 'init:err';
  id: WorkerMessageId;
  error?: string;
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
  /** The URL the caller sent: a declared route's handler gets it as `request.url` (ADR 0039). */
  url?: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** The request's bytes, unchanged: a binary upload crosses as sent (ADR 0039 decision 3). */
  body?: Uint8Array<ArrayBuffer>;
}

export interface RouteInvokeResponse {
  type: 'route:ok' | 'route:err';
  id: WorkerMessageId;
  status?: number;
  headers?: Record<string, string>;
  /** The response's bytes, unchanged: a handler's binary answer crosses as sent. */
  body?: Uint8Array<ArrayBuffer>;
  error?: string;
  /**
   * The handler threw and Hono rendered the error (`c.error`): the host rolls
   * the request's transaction back, as `tenantMiddleware` does inline.
   */
  threw?: boolean;
}

// ── Actions (host → worker → host) ──────────────────────────────────

/**
 * Run the extension's action `name` (ADR 0056): `args` are its validated input
 * and the request's time zone. Its `host` calls are `host:call` op `action`,
 * naming this `id`, which the host records as an invocation of its own.
 */
export interface ActionInvokeRequest {
  type: 'action:invoke';
  id: WorkerMessageId;
  name: string;
  args: unknown[];
}

export interface ActionInvokeResponse {
  type: 'action:ok' | 'action:err';
  id: WorkerMessageId;
  result?: unknown;
  error?: string;
  /**
   * An `ActionRefusal`, carried as fields: the `Symbol.for` mark that makes it
   * one does not cross. The host answers only a status the SDK allows.
   */
  refusal?: { status?: unknown; code?: unknown; message?: string };
  /** The `host:call` whose refusal the action let through: the host rethrows its own error. */
  hostError?: WorkerMessageId;
}

// ── Host calls (worker → host): a declared route's or action's `host` ──

/**
 * `action`: an action's `host` (ADR 0056), `[member, ...its arguments]`,
 * answered by the `ActionHost` the engine built for the invocation.
 * `collections`: a declared route's `host.collections` (ADR 0025), `[call,
 * ...its arguments]`. Identity is never an argument: the host answers as the
 * invocation `requestId` names, from its own record of it.
 */
export type HostCallOp = 'action' | 'collections';

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
  /** The refusal's HTTP status: what a route answers with if it does not catch. */
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

// ── Union ───────────────────────────────────────────────────────────

export type HostToWorkerMessage =
  | InitRequest
  | ShutdownRequest
  | RouteInvokeRequest
  | ActionInvokeRequest
  | PingRequest
  | HostCallResponse;

export type WorkerToHostMessage =
  | InitResponse
  | RouteInvokeResponse
  | ActionInvokeResponse
  | LogMessage
  | PongResponse
  | HostCallRequest;
