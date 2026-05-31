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
  // Identity surface the host stitched in. Worker treats as read-only.
  user?: { id: string; email: string };
  tenantId?: string;
}

export interface RouteInvokeResponse {
  type: 'route:ok' | 'route:err';
  id: WorkerMessageId;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

// ── DB ──────────────────────────────────────────────────────────────

export interface DbQueryRequest {
  type: 'db:query';
  id: WorkerMessageId;
  sql: string;
  params: unknown[];
}

export interface DbQueryResponse {
  type: 'db:ok' | 'db:err';
  id: WorkerMessageId;
  rows?: unknown[];
  error?: string;
}

// ── Services ────────────────────────────────────────────────────────

export interface ServiceCallRequest {
  type: 'service:call';
  id: WorkerMessageId;
  name: string;
  args: unknown[];
}

export interface ServiceCallResponse {
  type: 'service:ok' | 'service:err';
  id: WorkerMessageId;
  result?: unknown;
  error?: string;
}

// ── Log forwarding (worker → host) ──────────────────────────────────

export interface LogMessage {
  type: 'log';
  level: 'log' | 'warn' | 'error';
  message: string;
}

// ── Union ───────────────────────────────────────────────────────────

export type HostToWorkerMessage =
  | InitRequest
  | ShutdownRequest
  | RouteInvokeRequest
  | DbQueryResponse
  | ServiceCallResponse;

export type WorkerToHostMessage =
  | InitResponse
  | RouteInvokeResponse
  | DbQueryRequest
  | ServiceCallRequest
  | LogMessage;
