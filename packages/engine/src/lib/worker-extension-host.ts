/**
 * WorkerExtensionHost — runs each worker-isolated (third-party) extension in a
 * process of its own (the runner in production, a local child elsewhere:
 * worker-extension-transport.ts) and coordinates the RPC bridge described in
 * worker-extension-protocol.ts.
 *
 * Lifecycle:
 *   1. `start(name, bundleUrl, ctx)` spawns the worker, sends `init`,
 *      receives the route table, mounts proxy routes under `/ext/<name>/*`.
 *   2. Inbound HTTP hits the proxy → IPC to worker → handler runs → IPC
 *      back → response written to client.
 *   3. Worker DB queries arrive as `db:query` → host executes via the
 *      real shared pool → posts `db:ok` / `db:err` back.
 *   4. `stop(name)` ends the process and removes proxy routes.
 *
 * Reliability (alpha.122):
 *   - Crash auto-recovery: worker.onerror / unexpected exit → respawn
 *     with exponential backoff. workerGeneration is incremented per
 *     respawn so operators can detect flapping.
 *   - Hang detection: heartbeat ping every 30s, terminate + respawn
 *     after 60s with no pong. Prevents a stuck extension from holding
 *     proxy routes open forever.
 *   - Service registry bridge: workers can ctx.services.register() now;
 *     calls from other workers / inline extensions route through the
 *     host registry to the publishing worker.
 *
 * Security envelope:
 *   - Worker never receives DATABASE_URL or any other env credential.
 *   - All SQL is executed by the host with the host's pool — RLS still
 *     applies, tenant scoping still works.
 *   - The extension is a process. On the runner it runs under a uid of
 *     its own with kernel limits (RFC extension-runner); as a local child
 *     (`process`, development) under the engine's uid, with no boundary.
 */

import type { Context, Hono } from 'hono';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ensureWorkerRuntimeOnDisk, startRunner, stopRunner } from './ext-runner.js';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
  RouteDescriptor,
  RouteInvokeResponse,
  InitResponse,
} from './worker-extension-protocol.js';
import {
  type ExtensionChannel,
  extensionTransport,
  spawnProcessRunner,
  connectRunner,
} from './worker-extension-transport.js';
import {
  callableDeps,
  reachableOwner,
  type ServiceDeps,
  serviceCallRefusal,
  serviceRegistry,
} from './service-registry.js';
import { getDb, type Database } from '../db/index.js';
import { sqlState } from '../db/bun-sql-quirks.js';
import type { RawPool } from '../db/bun-sql-dialect.js';
import {
  CREDENTIAL_HEADERS,
  activationMiddlewareFor,
  extensionLoader,
  guardEventHandler,
} from './extensions/index.js';
import { compilePattern } from '../middleware/extension-auth-gate.js';
import { ProblemException, problem, problemOnError } from './problem.js';
import { engineEvents } from './runtime/index.js';
import {
  assertWorkerSqlAllowed,
  workerDbRoleFor,
  workerSqlEngineTables,
} from './extensions/index.js';
import {
  NO_UNITS,
  getCurrentDomainOrNull,
  getRequestActor,
  getResolvedMembership,
  type RequestActor,
  runWithDomain,
  temporaryObjectsRestricted,
  withTenantIsolation,
} from './tenancy/index.js';

let _instance: WorkerExtensionHost | null = null;

/**
 * Lazy singleton — first call wires the host to the engine's main
 * Hono app. Subsequent calls return the same instance.
 */
export function getWorkerHost(app: Hono): WorkerExtensionHost {
  if (!_instance) {
    _instance = new WorkerExtensionHost(app);
  } else {
    // Rebind rather than ignore the argument. Hot-reload passes the freshly
    // built app here; keeping the original meant proxy routes were mounted on
    // an app that had already been replaced.
    _instance.rebindApp(app);
  }
  return _instance;
}

export function getWorkerHostIfInitialized(): WorkerExtensionHost | null {
  return _instance;
}

/**
 * Resets the singleton (test helper / hot-reload teardown). Real
 * cleanup of running workers must be done via `stopAll()` first.
 */
export function _resetWorkerHostForTests(): void {
  _instance = null;
}

/** Per-extension health surface returned by getHealth(). No RSS field: the
 *  extension's process may be the runner's, which the engine cannot read. */
export interface WorkerHealth {
  name: string;
  isolation: 'worker';
  status: 'running' | 'crashed' | 'starting';
  workerGeneration: number;
  enabledAt: string;
  lastCrashAt?: string;
  lastHangAt?: string;
  loadError?: string;
  inFlightRequests: number;
  totalRequests: number;
  bundleHashPrefix?: string;
  integrityOk: boolean;
  routes: number;
}

/**
 * What the host recorded for an invocation it dispatched: the tenant of the
 * request, and the caller that request's transaction runs as (absent for work
 * with no tenant transaction — the old tenant-only behaviour).
 */
interface InvokeScope {
  tenantId: string | null;
  actor?: RequestActor;
  /** The caller's reach in the tenant resolved to no unit: every assignment lapsed. */
  noUnits?: boolean;
  /** `c.get('user')` as the `/ext/*` gate left it: the one user `checkPermission` answers for. */
  user?: { id?: string };
  /** The request's async context — domain, tenant, the API key the gate admitted. */
  run?: <R>(fn: () => R) => R;
  /** The request's own session, looked up with its own headers. */
  session?: () => Promise<unknown>;
  /**
   * The route request's database transaction (RFC step 8). Shared with a
   * worker service it calls, which joins it as an inline service would.
   */
  txn?: RequestTxn;
}

/**
 * What a worker's `ctx` asks the host for (RFC extension-runner, step 7): the
 * members `buildRestrictedContext` gives the same extension inline, so a host
 * call is answered by the inline code itself.
 */
export interface WorkerCtxSource {
  config?: unknown;
  checkPermission?: (userId: string, resource: string, action: string) => Promise<boolean>;
  auth?: { api: { getSession(args: { headers: Headers }): Promise<unknown> } };
  /** Manifest `forwardCredentials`: public route pattern → credential headers it receives. */
  forwardCredentials?: Record<string, readonly string[]>;
}

/**
 * The request headers a worker is handed: all of them but the caller's
 * credentials (`CREDENTIAL_HEADERS`), save those in `forward`.
 *
 * The worker is the extension the platform chose not to trust. Handed the
 * caller's cookie or API key, it could replay them and act as the caller on
 * every route of the instance. It needs neither: the host resolves the session
 * itself (`ctx.auth`), and signature headers (`stripe-signature`, …) still pass.
 */
export function workerRequestHeaders(
  raw: Headers,
  forward: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const strip = new Set<string>(CREDENTIAL_HEADERS);
  const headers: Record<string, string> = {};
  raw.forEach((v, k) => {
    const name = k.toLowerCase();
    if (!strip.has(name) || forward.has(name)) headers[name] = v;
  });
  return headers;
}

interface ManagedWorker {
  name: string;
  extDir: string;
  bundleEntry: string;
  /** Its process: the runner's, or a local child (worker-extension-transport.ts). */
  worker: ExtensionChannel;
  routes: RouteDescriptor[];
  pendingInvokes: Map<string, (res: RouteInvokeResponse) => void>;
  /**
   * Tenant and caller of each in-flight `route:invoke`, keyed by the id the host
   * minted.
   *
   * This is the host's own record of what it dispatched. `db:query` names an
   * invocation and the tenant and user are read from here — never from the
   * message, since the worker is the untrusted party and a tenant or user it
   * asserts is one it picked.
   */
  invokeTenants: Map<string, InvokeScope>;
  /**
   * `db.transaction()` callbacks running outside a request (owner decision 4),
   * by the id the worker minted for each: one host transaction, one connection.
   */
  hostTxns?: Map<string, HostTxn>;
  pendingInits: Map<string, (res: InitResponse) => void>;
  pendingPings: Map<string, () => void>;
  /** Service names this worker has registered. Used to unregister on
   *  respawn so stale entries don't shadow the new worker's exports. */
  registeredServices: Set<string>;
  /** Manifest `dependencies`: a call into one that is down answers 503. */
  dependencies: ReadonlySet<string>;
  /** `dependencies` + `optionalDependencies`: the owners whose services it may call. */
  mayCall: ServiceDeps;
  /** Between a crash and the fresh spawn: in the map, but answering nothing. */
  respawning?: boolean;
  source?: WorkerCtxSource;
  /** Its `ctx.events.on` subscriptions on the engine bus, by listener key. */
  listeners?: Map<string, () => void>;
  proxyUnmount: () => void;
  // Health bookkeeping
  workerGeneration: number;
  enabledAt: number;
  lastCrashAt?: number;
  lastHangAt?: number;
  loadError?: string;
  inFlightRequests: number;
  totalRequests: number;
  bundleHashPrefix?: string;
  // Heartbeat
  heartbeatTimer?: ReturnType<typeof setInterval>;
  stopped: boolean;
}

/**
 * Correlation id for a host↔worker message.
 *
 * Random rather than sequential. These ids were `inv-svc-1`, `inv-svc-2`, …
 * from a process-wide counter, and `invokeWaiters` is keyed on them, so a
 * worker could guess the id of a cross-extension call it was not party to and
 * answer it. The sender check below is the real defence; unpredictable ids mean
 * an attacker cannot even name someone else's pending call.
 */
/**
 * The load error for an extension whose runner cannot be reached. Fail closed:
 * the extension is not loaded (its `loadError` in /api/admin/extensions/health,
 * an `extension.load_failed` audit row), never run in or beside the engine.
 */
export function runnerUnreachable(err: unknown): Error {
  const why = err instanceof Error || err instanceof ErrorEvent ? err.message : String(err);
  return new Error(
    `extension runner unreachable (${why}). Third-party extensions run only on the ` +
      `runner in production: start it (compose: the ext-runner service; bare metal: ` +
      `\`zveltio ext-runner setup\`; Helm: extRunner.enabled).`,
  );
}

/**
 * The channel to a new process for the extension: the runner, or a local child
 * of the engine outside production. Never a local child in the runner's place —
 * an unreachable runner is a load error (`enforceRunnerInProduction` refuses
 * `process` in production before this).
 */
async function openExtensionChannel(extName: string): Promise<ExtensionChannel> {
  if (extensionTransport() === 'runner') {
    const socket = await startRunner(extName).catch((err) => {
      throw runnerUnreachable(err);
    });
    return connectRunner(socket);
  }
  return spawnProcessRunner(ensureWorkerRuntimeOnDisk(), {
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  });
}

function rpcId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const MAX_RESPAWN_BACKOFF_MS = 30_000;

export class WorkerExtensionHost {
  private readonly workers = new Map<string, ManagedWorker>();
  private respawnBackoff = new Map<string, number>();

  constructor(
    private app: Hono,
    /** Opens a new extension process's channel; tests pass a fake one. */
    private readonly open: (extName: string) => Promise<ExtensionChannel> = openExtensionChannel,
  ) {}

  /**
   * Point the host at the CURRENT Hono app.
   *
   * A hot-reload builds a fresh app and re-registers every extension onto it,
   * but the host is a singleton that captured the app it was constructed with.
   * Mounting a worker's proxy routes then targeted the discarded app — whose
   * router had already served requests — and Hono threw "Can not add a route
   * since the matcher is already built", so the extension's routes never
   * appeared and /ext/<name>/* returned 404.
   */
  rebindApp(app: Hono): void {
    this.app = app;
  }

  /**
   * Spawn a worker for the extension at `extDir` and mount its routes
   * under `/ext/<name>/*` in the main Hono app. Returns when the worker
   * has reported its route table (i.e. `register()` ran successfully).
   */
  async start(
    extName: string,
    extDir: string,
    bundleEntry: string,
    dependencies: readonly string[] = [],
    /** Its `ServiceDeps`: `dependencies` + `optionalDependencies`, absent ones marked. */
    mayCall: ServiceDeps = callableDeps(dependencies),
    source: WorkerCtxSource = {},
  ): Promise<void> {
    if (this.workers.has(extName)) {
      throw new Error(`Worker for "${extName}" is already running`);
    }
    const managed = await this.spawn(
      extName,
      extDir,
      bundleEntry,
      1,
      new Set(dependencies),
      mayCall,
      source,
    );
    this.workers.set(extName, managed);
    managed.proxyUnmount = this.mountProxyRoutes(managed);
    managed.heartbeatTimer = setInterval(() => this.heartbeat(managed), HEARTBEAT_INTERVAL_MS);
    console.log(
      `🧵 Extension "${extName}" loaded in worker (${managed.routes.length} routes, gen ${managed.workerGeneration})`,
    );
  }

  /** Tear down a worker and remove its proxy routes. */
  async stop(extName: string): Promise<void> {
    const managed = this.workers.get(extName);
    if (!managed) return;
    managed.stopped = true;
    if (managed.heartbeatTimer) clearInterval(managed.heartbeatTimer);
    managed.proxyUnmount();
    for (const svc of managed.registeredServices) {
      serviceRegistry.unregisterAs(extName, svc);
    }
    dropListeners(managed);
    failPendingInvokes(extName);
    failPendingRoutes(managed);
    managed.worker.terminate();
    this.workers.delete(extName);
    this.respawnBackoff.delete(extName);
    // Disable stops the extension's runner unit, not only its runtime.
    if (extensionTransport() === 'runner') {
      await stopRunner(extName).catch((err) =>
        console.error(`[worker:${extName}] stopping its runner: ${(err as Error).message}`),
      );
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.workers.keys()].map((n) => this.stop(n)));
  }

  isRunning(extName: string): boolean {
    return this.workers.has(extName);
  }

  /**
   * Mount a running worker's proxy routes on the current app, keeping the worker.
   * False when none runs, or it is between a crash and a respawn (the caller
   * restarts it). A rebuild of the app re-registers code the worker already
   * runs; restarting it there spawned every worker twice at boot.
   */
  remount(extName: string): boolean {
    const managed = this.workers.get(extName);
    if (!managed || managed.respawning) return false;
    managed.proxyUnmount = this.mountProxyRoutes(managed);
    return true;
  }

  /** Per-extension health snapshot — used by /api/admin/extensions/health. */
  getHealth(): WorkerHealth[] {
    return [...this.workers.values()].map((m) => ({
      name: m.name,
      isolation: 'worker' as const,
      status: m.stopped ? 'crashed' : ('running' as const),
      workerGeneration: m.workerGeneration,
      enabledAt: new Date(m.enabledAt).toISOString(),
      lastCrashAt: m.lastCrashAt ? new Date(m.lastCrashAt).toISOString() : undefined,
      lastHangAt: m.lastHangAt ? new Date(m.lastHangAt).toISOString() : undefined,
      loadError: m.loadError,
      inFlightRequests: m.inFlightRequests,
      totalRequests: m.totalRequests,
      bundleHashPrefix: m.bundleHashPrefix,
      integrityOk: true, // engine loader rejected hash mismatch before reaching us
      routes: m.routes.length,
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * Single-attempt spawn. Returns a half-populated ManagedWorker on
   * success; the caller is responsible for mounting proxy routes +
   * starting the heartbeat. Throws on init failure.
   */
  private async spawn(
    extName: string,
    extDir: string,
    bundleEntry: string,
    generation: number,
    dependencies: ReadonlySet<string>,
    mayCall: ServiceDeps,
    source: WorkerCtxSource,
  ): Promise<ManagedWorker> {
    const bundleUrl = pathToFileURL(join(extDir, bundleEntry)).href;
    const transport = extensionTransport();
    const worker = await this.open(extName);
    const managed: ManagedWorker = {
      name: extName,
      extDir,
      bundleEntry,
      worker,
      routes: [],
      pendingInvokes: new Map(),
      invokeTenants: new Map(),
      pendingInits: new Map(),
      pendingPings: new Map(),
      registeredServices: new Set(),
      dependencies,
      mayCall,
      source,
      listeners: new Map(),
      proxyUnmount: () => {},
      workerGeneration: generation,
      enabledAt: Date.now(),
      inFlightRequests: 0,
      totalRequests: 0,
      stopped: false,
    };

    // A channel that ends before `init` answers fails the load at once, with its
    // reason (an unreachable runner's socket error), not after the 15 s timeout.
    let failInit: ((err: Error) => void) | null = null;
    worker.onmessage = (e) => this.handleWorkerMessage(managed, e.data);
    worker.onerror = (e) => {
      console.error(`[worker:${extName}] error:`, e.message);
      if (failInit) failInit(transport === 'runner' ? runnerUnreachable(e) : new Error(e.message));
      else this.scheduleRespawn(managed, `onerror: ${e.message}`);
    };

    const initId = rpcId('init');
    const init = await new Promise<InitResponse>((resolve, reject) => {
      failInit = (err) => {
        managed.pendingInits.delete(initId);
        reject(err);
      };
      managed.pendingInits.set(initId, resolve);
      setTimeout(() => {
        if (managed.pendingInits.has(initId)) {
          managed.pendingInits.delete(initId);
          worker.terminate();
          reject(new Error(`worker "${extName}" did not init within 15s`));
        }
      }, 15_000);
      this.post(managed, {
        type: 'init',
        id: initId,
        bundleUrl,
        extName,
        env: {
          NODE_ENV: process.env.NODE_ENV ?? 'production',
          extensionPath: extDir,
        },
        config: source.config,
      });
    });
    failInit = null;

    if (init.type === 'init:err') {
      worker.terminate();
      managed.loadError = init.error;
      throw new Error(`worker "${extName}" init failed: ${init.error}`);
    }
    managed.routes = init.routes ?? [];
    return managed;
  }

  /**
   * Crash recovery: terminate the current worker, exponential-backoff
   * a fresh spawn, transfer the proxy routes to the new worker. The
   * Hono sub-app stays mounted; it just gets a new ManagedWorker
   * underneath.
   */
  private scheduleRespawn(managed: ManagedWorker, reason: string): void {
    if (managed.stopped) return;
    if (!this.workers.has(managed.name)) return;
    managed.lastCrashAt = Date.now();
    managed.respawning = true;
    if (managed.heartbeatTimer) clearInterval(managed.heartbeatTimer);
    try {
      managed.worker.terminate();
    } catch {
      /* worker may already be dead */
    }
    for (const svc of managed.registeredServices) {
      serviceRegistry.unregisterAs(managed.name, svc);
    }
    managed.registeredServices.clear();
    // The fresh worker's register() subscribes again.
    dropListeners(managed);
    // A caller waiting on the dead worker would otherwise sit out the 30s timeout.
    failPendingInvokes(managed.name);
    // And so would its HTTP requests, holding their transactions open.
    failPendingRoutes(managed);
    const prevBackoff = this.respawnBackoff.get(managed.name) ?? 500;
    const backoff = Math.min(prevBackoff * 2, MAX_RESPAWN_BACKOFF_MS);
    this.respawnBackoff.set(managed.name, backoff);
    console.warn(`🔄 Respawning worker "${managed.name}" in ${backoff}ms — reason: ${reason}`);
    setTimeout(async () => {
      if (managed.stopped) return;
      if (!this.workers.has(managed.name)) return;
      try {
        const fresh = await this.spawn(
          managed.name,
          managed.extDir,
          managed.bundleEntry,
          managed.workerGeneration + 1,
          managed.dependencies,
          managed.mayCall,
          managed.source ?? {},
        );
        // Carry over the proxy-mount + bookkeeping; the old ManagedWorker
        // is replaced in the registry by the new one.
        fresh.proxyUnmount = managed.proxyUnmount;
        fresh.totalRequests = managed.totalRequests;
        fresh.lastCrashAt = managed.lastCrashAt;
        fresh.lastHangAt = managed.lastHangAt;
        fresh.bundleHashPrefix = managed.bundleHashPrefix;
        this.workers.set(managed.name, fresh);
        fresh.heartbeatTimer = setInterval(() => this.heartbeat(fresh), HEARTBEAT_INTERVAL_MS);
        // Reset backoff on successful respawn
        this.respawnBackoff.set(managed.name, 500);
        console.log(`✓ Worker "${managed.name}" respawned (gen ${fresh.workerGeneration})`);
      } catch (err) {
        console.error(`❌ Respawn failed for "${managed.name}":`, (err as Error).message);
        // Schedule another attempt with further backoff
        this.scheduleRespawn(managed, `respawn-failed: ${(err as Error).message}`);
      }
    }, backoff);
  }

  /** Ping/pong heartbeat — fires a hang+respawn if no reply in 60s. */
  private heartbeat(managed: ManagedWorker): void {
    if (managed.stopped) return;
    const id = rpcId('ping');
    const timeout = setTimeout(() => {
      if (managed.pendingPings.has(id)) {
        managed.pendingPings.delete(id);
        managed.lastHangAt = Date.now();
        console.warn(
          `⏱ Worker "${managed.name}" did not pong within ${HEARTBEAT_TIMEOUT_MS}ms — respawning`,
        );
        this.scheduleRespawn(managed, 'heartbeat timeout');
      }
    }, HEARTBEAT_TIMEOUT_MS);
    managed.pendingPings.set(id, () => clearTimeout(timeout));
    this.post(managed, { type: 'ping', id });
  }

  private post(managed: ManagedWorker, msg: HostToWorkerMessage): void {
    managed.worker.postMessage(msg);
  }

  private handleWorkerMessage(managed: ManagedWorker, msg: WorkerToHostMessage): void {
    switch (msg.type) {
      case 'init:ok':
      case 'init:err': {
        const cb = managed.pendingInits.get(msg.id);
        if (cb) {
          managed.pendingInits.delete(msg.id);
          cb(msg);
        }
        break;
      }
      case 'route:ok':
      case 'route:err': {
        const cb = managed.pendingInvokes.get(msg.id);
        if (cb) {
          managed.pendingInvokes.delete(msg.id);
          cb(msg);
        }
        break;
      }
      case 'db:query':
        void this.handleDbQuery(managed, msg);
        break;
      case 'service:call':
        void this.handleServiceCall(managed, msg);
        break;
      case 'service:register':
        this.handleServiceRegister(managed, msg);
        break;
      case 'host:call':
        void this.handleHostCall(managed, msg);
        break;
      case 'service:invoke:ok':
      case 'service:invoke:err': {
        // Reply from a worker that owns a service we asked it to invoke.
        // Route the reply back to whichever inline/host caller is waiting.
        const waiter = invokeWaiters.get(msg.id);
        // Only the worker that was asked may answer. Without this any worker
        // could resolve any pending cross-extension call with forged data.
        if (waiter && waiter.expect === managed.name) {
          invokeWaiters.delete(msg.id);
          waiter.resolve(msg);
        } else if (waiter) {
          console.warn(
            `[worker-host] extension "${managed.name}" replied to invoke ${msg.id}, ` +
              `which was sent to "${waiter.expect}" — dropped`,
          );
        }
        break;
      }
      case 'pong': {
        const ack = managed.pendingPings.get(msg.id);
        if (ack) {
          managed.pendingPings.delete(msg.id);
          ack();
        }
        break;
      }
      case 'log':
        console[msg.level](`[worker:${managed.name}] ${msg.message}`);
        break;
    }
  }

  private async handleDbQuery(
    managed: ManagedWorker,
    msg: Extract<WorkerToHostMessage, { type: 'db:query' }>,
  ): Promise<void> {
    try {
      // The tenant of the request this query was issued under, from the host's
      // own dispatch record. A query outside any request — a background hook —
      // names no id and runs with no tenant context, which the isolation
      // predicate resolves to the default tenant rather than to everything. A
      // query naming a request that is over is refused (`requestScope`).
      let scope: InvokeScope | undefined;
      try {
        scope = requestScope(managed, msg.requestId, 'query');
      } catch (err) {
        // A transaction outliving the invocation it was opened in ends with it.
        if (msg.txn) endHostTxn(managed, msg.txn, 'rolled back: its invocation is over');
        throw err;
      }
      // Inside a request the transaction id names nothing: the request is the
      // transaction (RFC step 8), and the worker cannot open a second one in it.
      const rows =
        msg.txn && !scope?.txn
          ? await hostTxnStatement(managed, msg, msg.txn, scope)
          : msg.savepoint
            ? await requestSavepoint(managed.name, scope, msg.savepoint)
            : await runRawWithParams(managed.name, msg.sql, msg.params, scope);
      // The affected-row count rides on Bun's result array, which neither
      // transport carries across: an UPDATE without RETURNING reported 0.
      const count = (rows as { count?: unknown }).count;
      this.post(managed, {
        type: 'db:ok',
        id: msg.id,
        rows,
        ...(typeof count === 'number' ? { count } : {}),
      });
    } catch (err) {
      // The SQLSTATE, as the inline driver puts it on the error: without it a
      // unique violation the extension answers with 400 was a 500.
      const errno = sqlState(err);
      this.post(managed, {
        type: 'db:err',
        id: msg.id,
        error: (err as Error).message,
        ...(errno ? { errno, code: (err as { code?: string }).code } : {}),
      });
    }
  }

  /**
   * Worker B (or an inline extension) asked for service "X.foo". Look
   * up the host registry: if X.foo was registered by an inline
   * extension, call it directly. If it was registered by another
   * worker, post `service:invoke` to that worker and await its reply.
   *
   * Either way the call is answered as the tenant of the request the worker is
   * serving — read from the host's own record, refused once that request is
   * over, exactly as a query is. It used to be answered as nobody: the inline
   * service ran from this message event with no tenant context, and the
   * worker's service ran its queries under no request, so a call made while
   * serving tenant B read the default tenant's rows.
   */
  private async handleServiceCall(
    managed: ManagedWorker,
    msg: Extract<WorkerToHostMessage, { type: 'service:call' }>,
  ): Promise<void> {
    try {
      const scope = requestScope(managed, msg.requestId, 'service call') ?? { tenantId: null };
      const { tenantId, actor } = scope;
      const name = msg.name;
      const ownerWorker = this.findServiceOwner(name);
      // An optional dependency too old to use is absent, as an uninstalled one is.
      const owner = reachableOwner(
        managed.mayCall,
        ownerWorker?.name ?? serviceRegistry.ownerOf(name),
      );
      if (owner === null) {
        // Unregistered. If a hard dependency is down that is why, and the caller
        // should hear it as such rather than as a missing name. An absent
        // optional one is just not found.
        const down = [...managed.dependencies].filter((d) => !this.isDependencyRunning(d));
        const named = down.find((d) => name.startsWith(`${d}.`));
        if (named || down.length > 0) throw dependencyDown(named ?? down.join('", "'));
        throw new Error(`service "${msg.name}" not found`);
      }
      // The broker is the only path between extensions, so it is where a worker
      // is held to what its manifest declared — not to whatever got registered.
      const refusal = serviceCallRefusal(managed.name, managed.mayCall, owner, name);
      if (refusal) throw new Error(refusal);
      if (ownerWorker && ownerWorker.name !== managed.name) {
        const result = await this.invokeWorkerService(ownerWorker, msg.name, msg.args, scope);
        this.post(managed, { type: 'service:ok', id: msg.id, result });
        return;
      }
      // Fall back to inline registry (host-side services).
      const impl = serviceRegistry.get<(...args: unknown[]) => unknown>(name);
      if (typeof impl !== 'function') throw new Error(`service "${msg.name}" is not callable`);
      const call = () => Promise.resolve(impl(...msg.args));
      // The context an inline extension's code has while serving a request of
      // that tenant — the domain `tenantMiddleware` opens and the tenant
      // transaction inside it — so the service's `ctx.db` and its permission
      // checks resolve the caller's tenant — and, opened with the same caller,
      // the row rules keyed on that user. No request, no tenant: unchanged.
      const result = tenantId
        ? await runWithDomain(tenantId, () => withTenantIsolation(tenantId, call, actor))
        : await call();
      this.post(managed, { type: 'service:ok', id: msg.id, result });
    } catch (err) {
      this.post(managed, {
        type: 'service:err',
        id: msg.id,
        error: (err as Error).message,
        ...(isDependencyDown(err) ? { status: 503 } : {}),
      });
    }
  }

  /**
   * A `ctx` member only the host can answer (RFC step 7), answered as the request
   * the call names — from the host's own record of it, never from the worker.
   * `checkPermission` answers for that request's user and no other, with the
   * inline extension's own check run in the request's async context (its tenant,
   * and the API key the gate admitted); outside a request it answers false.
   */
  private async handleHostCall(
    managed: ManagedWorker,
    msg: Extract<WorkerToHostMessage, { type: 'host:call' }>,
  ): Promise<void> {
    try {
      const scope = requestScope(managed, msg.requestId, msg.op);
      const run = scope?.run ?? (<R>(fn: () => R) => fn());
      const session = async () => (scope?.session ? await run(scope.session) : null) ?? null;
      const [a, b, c] = msg.args;
      const { op } = msg;
      let result: unknown;
      switch (op) {
        case 'getSession':
          result = await session();
          break;
        case 'checkPermission': {
          const check = managed.source?.checkPermission;
          const who =
            scope?.user?.id ?? ((await session()) as { user?: { id?: string } } | null)?.user?.id;
          result =
            !!check &&
            typeof a === 'string' &&
            a === who &&
            (await run(() => check(a, String(b), String(c))));
          break;
        }
        case 'emit': {
          const event = refuseEvent(managed, a, 'emit');
          if (c) await run(() => engineEvents.emitAsync(event as never, b as never));
          else run(() => engineEvents.emit(event as never, b as never));
          break;
        }
        case 'on':
          this.subscribe(managed, refuseEvent(managed, a, 'on'), String(b));
          break;
        case 'off':
          managed.listeners?.get(String(a))?.();
          managed.listeners?.delete(String(a));
          break;
        default:
          throw new Error(`unknown host call "${String(msg.op)}"`);
      }
      this.post(managed, { type: 'host:ok', id: msg.id, result });
    } catch (err) {
      this.post(managed, {
        type: 'host:err',
        id: msg.id,
        error: (err as Error).message,
        ...(err instanceof ProblemException ? { status: err.status } : {}),
      });
    }
  }

  /**
   * Deliver `event` to the worker's listener `key`, as the tenant and caller it
   * was emitted for, and only where the extension is active for that tenant
   * (`guardEventHandler`, as an inline listener).
   */
  private subscribe(managed: ManagedWorker, event: string, key: string): void {
    const deliver = (payload: unknown) =>
      this.invokeWorkerService(
        managed,
        key,
        [payload],
        currentScope(getCurrentDomainOrNull()),
        'event:deliver',
      ).catch((err: Error) =>
        console.error(`[worker:${managed.name}] listener for "${event}" failed: ${err.message}`),
      );
    const listener = (payload: unknown) =>
      guardEventHandler(deliver, managed.name, getDb())(payload);
    managed.listeners ??= new Map();
    managed.listeners.get(key)?.();
    managed.listeners.set(key, engineEvents.on(event as never, listener as never));
  }

  /** A worker dependency counts as running only while its worker is up; an
   *  inline one while the loader has it. */
  private isDependencyRunning(name: string): boolean {
    const w = this.workers.get(name);
    if (w) return !w.stopped && !w.respawning;
    const loaded = extensionLoader.loaded.get(name);
    return loaded !== undefined && !loaded.workerIsolation;
  }

  /**
   * Ask `target` to run a service it registered, on behalf of a caller in
   * `scope`, and return its result.
   *
   * The invoke id is recorded in the target's `invokeTenants` for as long as the
   * call is pending, so the queries the service makes under it run as the
   * caller's tenant and user — the same record, and the same lifetime, as a
   * route invocation's. Without it the service queried as no request at all, which
   * the isolation predicate answers with the default tenant.
   */
  private async invokeWorkerService(
    target: ManagedWorker,
    name: string,
    args: unknown[],
    scope: InvokeScope,
    type: 'service:invoke' | 'event:deliver' = 'service:invoke',
  ): Promise<unknown> {
    const invokeId = rpcId('inv-svc');
    target.invokeTenants.set(invokeId, scope);
    try {
      const reply = await new Promise<
        Extract<WorkerToHostMessage, { type: 'service:invoke:ok' | 'service:invoke:err' }>
      >((resolve, reject) => {
        invokeWaiters.set(invokeId, { expect: target.name, resolve, reject });
        setTimeout(() => {
          if (invokeWaiters.has(invokeId)) {
            invokeWaiters.delete(invokeId);
            reject(new Error(`service "${name}" call timeout (30s)`));
          }
        }, 30_000);
        this.post(target, { type, id: invokeId, name, args });
      });
      if (reply.type === 'service:invoke:err') {
        throw new Error(reply.error ?? 'service call failed');
      }
      return reply.result;
    } finally {
      target.invokeTenants.delete(invokeId);
    }
  }

  private handleServiceRegister(
    managed: ManagedWorker,
    msg: Extract<WorkerToHostMessage, { type: 'service:register' }>,
  ): void {
    try {
      // The scope holds it to `<extension>.*`: first-come registration let a
      // worker claim a name another extension publishes and answer its callers.
      // Publish a stub in the host registry that, when called, forwards
      // to the worker via service:invoke. This is what makes worker-
      // registered services callable from inline extensions / other
      // workers. The caller's tenant and user are the ones its async context
      // runs as.
      serviceRegistry
        .scope(managed.name)
        .register(msg.name, (...args: unknown[]) =>
          this.invokeWorkerService(managed, msg.name, args, currentScope(getCurrentDomainOrNull())),
        );
      managed.registeredServices.add(msg.name);
      this.post(managed, { type: 'service:register:ok', id: msg.id });
    } catch (err) {
      this.post(managed, {
        type: 'service:register:err',
        id: msg.id,
        error: (err as Error).message,
      });
    }
  }

  private findServiceOwner(serviceName: string): ManagedWorker | null {
    for (const w of this.workers.values()) {
      if (w.registeredServices.has(serviceName)) return w;
    }
    return null;
  }

  /**
   * Mount Hono proxy routes that forward each worker-declared route to
   * the worker via IPC. Returns a teardown function that unmounts them.
   */
  private mountProxyRoutes(managed: ManagedWorker): () => void {
    const { Hono } = require('hono') as typeof import('hono');
    const sub = new Hono();
    type HonoLike = Record<string, (path: string, handler: unknown) => unknown>;
    const subAny = sub as unknown as HonoLike;
    const forwarded = Object.entries(managed.source?.forwardCredentials ?? {}).map(
      ([pattern, names]) => [compilePattern(pattern), names] as const,
    );
    for (const r of managed.routes) {
      const method = r.method.toLowerCase();
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (typeof subAny[method] !== 'function') continue;
      subAny[method](
        r.path,
        async (c: {
          req: { raw: Request; query: () => Record<string, string> };
          // `tenant` is set by tenantMiddleware; typed narrowly here because the
          // proxy is registered on an untyped sub-app.
          get: (key: string) => unknown;
        }) => {
          const live = this.workers.get(managed.name);
          if (!live) return new Response('Extension worker is not running', { status: 503 });
          const bodyText = await c.req.raw.text().catch(() => '');
          const subPath = new URL(c.req.raw.url).pathname.replace(`/ext/${live.name}`, '') || '/';
          const headers = workerRequestHeaders(
            c.req.raw.headers,
            new Set(forwarded.filter(([re]) => re.test(subPath)).flatMap(([, h]) => h)),
          );
          const id = rpcId('inv');
          const reqTenantId = (c.get('tenant') as { id?: string } | null)?.id ?? null;
          const user = (c.get('user') ?? undefined) as { id?: string } | undefined;
          const auth = live.source?.auth;
          const txn = newRequestTxn();
          live.invokeTenants.set(id, {
            ...currentScope(reqTenantId),
            user,
            run: AsyncLocalStorage.snapshot(),
            session: async () => auth?.api.getSession({ headers: c.req.raw.headers }) ?? null,
            txn,
          });
          live.inFlightRequests++;
          live.totalRequests++;
          try {
            const resp = await new Promise<RouteInvokeResponse>((resolve, reject) => {
              live.pendingInvokes.set(id, resolve);
              setTimeout(() => {
                if (live.pendingInvokes.has(id)) {
                  live.pendingInvokes.delete(id);
                  reject(new Error('worker route handler timeout (30s)'));
                }
              }, 30_000);
              this.post(live, {
                type: 'route:invoke',
                id,
                method: r.method,
                path: subPath,
                headers,
                query: c.req.query(),
                body: bodyText || undefined,
                tenantId: reqTenantId ?? undefined,
                user,
              });
            });
            // The rule `tenantMiddleware` applies to an inline request: commit
            // unless the handler threw — whatever status it answered with.
            const commit = resp.type === 'route:ok' && !resp.threw;
            if (!(await endRequestTxn(txn, commit)) && commit) {
              return Response.json({ error: NOT_COMMITTED }, { status: 500 });
            }
            if (resp.type === 'route:err') {
              // An uncaught SQLSTATE answers as an inline route's (22P02 → 400, 55P03 → 503).
              if (resp.errno) {
                const err = Object.assign(new Error(resp.error), { errno: resp.errno });
                return problemOnError(err, c as unknown as Context);
              }
              return new Response(resp.error ?? 'worker error', { status: 500 });
            }
            return new Response(resp.body ?? '', {
              status: resp.status ?? 200,
              headers: resp.headers,
            });
          } catch (err) {
            return new Response((err as Error).message, { status: 500 });
          } finally {
            // Timed out, or the worker died: nothing it wrote is kept.
            await endRequestTxn(txn, false);
            live.inFlightRequests--;
            // The request is over, so the id can no longer name a tenant. Left
            // behind, this map grows for the lifetime of the process and a
            // worker could keep quoting a finished request's id to hold on to
            // its tenant context.
            live.invokeTenants.delete(id);
          }
        },
      );
    }
    // Per-firm activation. A worker-isolated extension never passes through
    // the guards `register.ts` puts on the handles it hands out — the host
    // mounts these proxy routes itself — so without this, "off for firm B"
    // would hold for every extension except the ones confined to a worker,
    // which are precisely the least trusted ones.
    //
    // Mounted on the sub-app rather than as `app.use('/ext/*', …)` on the way
    // in: that prefix runs before the pre-auth rate limits `routes/index.ts`
    // registers for public surfaces, and answering 404 ahead of a limiter
    // removes the throttle from an unauthenticated path.
    // Resolved per request, not at mount time: `getDb()` throws before
    // `initDatabase()`, and the proxy is mounted by callers that never open a
    // pool. No database is no answer, so it falls open, like every other
    // activation lookup that cannot be resolved.
    sub.use('*', async (c, next) => {
      let db: Database;
      try {
        db = getDb();
      } catch {
        return next();
      }
      return activationMiddlewareFor(managed.name, db)(c, next);
    });
    this.app.route(`/ext/${managed.name}`, sub);
    return () => {
      // Hono v4 doesn't expose unmount; the proxy sub-app stays mounted
      // and returns 503 once `stop()` removes the worker entry.
    };
  }
}

/** Test-only export — never import outside src/tests/. */
export const _internalForTests = {
  dispatchMessage(
    host: WorkerExtensionHost,
    managed: ManagedWorker,
    msg: WorkerToHostMessage,
  ): void {
    (
      host as unknown as { handleWorkerMessage(m: ManagedWorker, msg: WorkerToHostMessage): void }
    ).handleWorkerMessage(managed, msg);
  },
  mountProxy(host: WorkerExtensionHost, managed: ManagedWorker): () => void {
    return (host as unknown as { mountProxyRoutes(m: ManagedWorker): () => void }).mountProxyRoutes(
      managed,
    );
  },
  heartbeat(host: WorkerExtensionHost, managed: ManagedWorker): void {
    (host as unknown as { heartbeat(m: ManagedWorker): void }).heartbeat(managed);
  },
  resetInvokeWaiters(): void {
    invokeWaiters.clear();
  },
  /** The once-only "no worker SQL role" warning, so a test can see it fire. */
  resetNoWorkerSqlRoleWarning(): void {
    _warnedNoWorkerSqlRole = false;
  },
  newRequestTxn,
  failPendingRoutes,
  requestSavepoint,
  /** The request transaction's hard timeout; no argument restores the default. */
  setRequestTxnTimeoutMs(ms = REQUEST_TXN_TIMEOUT_MS): void {
    requestTxnTimeoutMs = ms;
  },
  /**
   * The tenant the host would apply to a `db:query` naming `requestId`.
   *
   * Exposed so a test can assert the resolution WITHOUT a database: the whole
   * point is that the answer comes from the host's dispatch record and not from
   * anything the worker sent, and that is a property of this lookup.
   */
  resolveDbTenant(managed: ManagedWorker, requestId?: string): string | null | undefined {
    return requestId ? managed.invokeTenants.get(requestId)?.tenantId : undefined;
  },
};

/**
 * The scope to record for an invocation made now, in `tenantId`: the caller the
 * current tenant transaction runs as rides along. Taken here, on the host, while
 * the request is live — the worker never gets a say in who it acts as.
 */
function currentScope(tenantId: string | null): InvokeScope {
  if (!tenantId) return { tenantId };
  const actor = getRequestActor();
  // The reach the request's own transaction resolved: `false` is NO_UNITS there.
  const userId = actor?.userId;
  const noUnits = !!userId && getResolvedMembership(userId, tenantId) === false;
  return { tenantId, actor, noUnits };
}

/**
 * The tenant and caller of the invocation a worker message names, from the
 * host's own record — `undefined` when it names none (background work), and a
 * refusal when it names one the record no longer holds.
 *
 * Refused, not demoted to no tenant: such a message is work a request started
 * and did not wait for (a timer, an un-awaited promise, a handler past the 30 s
 * timeout), still carrying the request's async context after the request ended.
 * Run tenantless, tenant B's leftover work read the default tenant's rows.
 */
function requestScope(
  managed: ManagedWorker,
  requestId: string | undefined,
  what: string,
): InvokeScope | undefined {
  if (!requestId) return undefined;
  if (!managed.invokeTenants.has(requestId)) {
    throw new Error(
      `request ${requestId} is over (or was never issued); a ${what} outliving ` +
        'its request has no tenant to run as',
    );
  }
  return managed.invokeTenants.get(requestId);
}

// Waiter pool for cross-worker service invokes.
//
// Module-scoped so any host method can stash a resolver under the rpcId — and
// that used to be the whole story: ANY worker's reply handler could route a
// response back, for ANY pending id. Combined with sequential ids, a
// worker-isolated extension could answer a service call made to a DIFFERENT
// extension and return whatever it liked. Cross-extension service calls are
// how extensions trust each other, so the caller believed it.
//
// `expect` pins the worker that was actually asked. A reply from anyone else
// is dropped.
const invokeWaiters = new Map<
  string,
  {
    expect: string;
    resolve: (
      msg: Extract<WorkerToHostMessage, { type: 'service:invoke:ok' | 'service:invoke:err' }>,
    ) => void;
    reject: (err: Error) => void;
  }
>();

const ENGINE_EVENT = /^(record|schema|user|flow)\.|^ai\.task\./;

/** Unsubscribe every `ctx.events.on` a worker made. */
function dropListeners(managed: ManagedWorker): void {
  for (const off of managed.listeners?.values() ?? []) off();
  managed.listeners?.clear();
}

/**
 * `event` if the worker may emit it or listen to it: its own `<name>.*` events,
 * and for `on` those of an extension it declared it depends on. Never the
 * engine's — a `record.*` payload carries rows the worker's own reads would not
 * return — and never another extension's emit, which listeners would believe.
 */
function refuseEvent(managed: ManagedWorker, event: unknown, op: 'emit' | 'on'): string {
  const owners = op === 'emit' ? [managed.name] : [managed.name, ...managed.mayCall.keys()];
  if (
    typeof event === 'string' &&
    // The engine's own (`EngineEventMap`), whatever an extension is named.
    !ENGINE_EVENT.test(event) &&
    owners.some((o) => o !== 'engine' && event.startsWith(`${o}.`))
  ) {
    return event;
  }
  throw new Error(
    `extension "${managed.name}" may not ${op === 'emit' ? 'emit' : 'listen to'} ` +
      `"${String(event)}": a worker-isolated extension ${op === 'emit' ? 'emits' : 'listens to'} ` +
      `only "<extension>.*" events of its own${op === 'on' ? ' or of its declared dependencies' : ''}`,
  );
}

/** Settle every call waiting on `extName`'s worker: it will not answer. */
function failPendingInvokes(extName: string): void {
  for (const [id, waiter] of invokeWaiters) {
    if (waiter.expect !== extName) continue;
    invokeWaiters.delete(id);
    waiter.reject(dependencyDown(extName));
  }
}

/**
 * Answer every route request the worker will not: it died or was stopped. Each
 * request then rolls its transaction back and releases the connection.
 */
function failPendingRoutes(managed: ManagedWorker): void {
  for (const [id, resolve] of managed.pendingInvokes) {
    managed.pendingInvokes.delete(id);
    resolve({ type: 'route:err', id, error: `worker "${managed.name}" exited mid-request` });
  }
  // And its transactions outside a request: no callback is left to end them.
  for (const id of managed.hostTxns?.keys() ?? []) {
    endHostTxn(managed, id, 'rolled back: the worker exited');
  }
}

const NOT_COMMITTED = 'The request could not be committed; nothing it wrote was kept.';

const DEPENDENCY_DOWN = 'extension.dependency_unavailable';

/** 503, so the HTTP caller sees "try again", not a server fault. */
function dependencyDown(extName: string): ProblemException {
  return problem(DEPENDENCY_DOWN, 503, `dependency "${extName}" is not running`);
}

function isDependencyDown(err: unknown): boolean {
  return err instanceof ProblemException && err.code === DEPENDENCY_DOWN;
}

/** Wall-clock ceiling for a single extension query, in seconds. */
const WORKER_QUERY_TIMEOUT_S = 10;

/**
 * Execute `sql` with `params` on behalf of a worker extension.
 *
 * This used to be `pool.unsafe(sql)` with nothing in front of it, which handed
 * every worker-isolated extension unrestricted SQL as the database owner — the
 * opposite of the intent, since `enforcePublisherTier` sends *untrusted*
 * community extensions down this path specifically because the worker is meant
 * to be the boundary. Three things now stand between the message and the
 * database:
 *
 *  - the table policy, which refuses references to engine `zv_*` tables the
 *    extension does not own (sessions, API keys, tenants, Casbin policies);
 *  - a reserved connection, which Bun drives through the extended-query
 *    protocol. `pool.unsafe()` uses the simple-query protocol and accepts
 *    several statements per command, so `…; DROP TABLE "user"` was previously a
 *    single message away. On a reserved connection the server rejects it;
 *  - a statement_timeout, so one extension cannot pin a connection forever.
 *
 *  - `SET ROLE zveltio_rls`, so the query runs as a plain role rather than as
 *    the database owner. On a stock install the engine connects as the image's
 *    POSTGRES_USER, which is a SUPERUSER, so worker SQL previously ran with
 *    every privilege Postgres has and RLS did not apply to it at all. Under the
 *    role, the isolation policies bind: with no tenant GUC on this connection
 *    the predicate resolves to the DEFAULT tenant (engine migration 029), so an
 *    extension sees one tenant's rows instead of all of them.
 *
 *  - the caller's tenant, set as the `zveltio.current_tenant` GUC so the
 *    isolation policies resolve to the tenant whose request this is. The host
 *    reads it from its OWN dispatch record, keyed by the invocation id the
 *    worker quotes — the worker never states a tenant, because a tenant it
 *    states is a tenant it chose.
 *
 * A query issued outside any request — a background hook, a scheduled task —
 * carries no invocation id and therefore no tenant. It gets the default
 * tenant's rows, which is what the predicate resolves to with no GUC. That is a
 * limitation rather than a hole: such code has no caller to inherit a tenant
 * from, and reading one tenant's data is a bug the extension can see, where
 * reading everyone's was one nobody could.
 */
/**
 * The role the worker SQL bridge switches to: the extension's own (`own`, made
 * at load under `zveltio_worker` — lib/extensions/ext-db-role.ts), else
 * `zveltio_worker`, else `zveltio_rls`, else null, and the bridge then refuses the query
 * rather than run it as the engine role (migration 001 creates both roles).
 *
 * Usable means this login may SET it, not merely that it exists: a membership
 * with SET FALSE failed `SET LOCAL ROLE`, which aborts the
 * transaction, so every worker query on such an install failed.
 */
export async function pickWorkerSqlRole(
  conn: { unsafe(q: string, params?: unknown[]): Promise<unknown> },
  own?: string,
): Promise<string | null> {
  const [picked] = (await conn.unsafe(
    `SELECT (SELECT rolname FROM pg_roles
              WHERE rolname IN ($1, 'zveltio_worker', 'zveltio_rls')
                AND pg_has_role(current_user, oid, 'SET')
              ORDER BY rolname = 'zveltio_rls', rolname = 'zveltio_worker' LIMIT 1) AS role`,
    [own ?? 'zveltio_worker'],
  )) as { role?: string | null }[];
  const role = picked?.role;
  return role && /^[a-z0-9_]+$/.test(role) ? role : null;
}

let _warnedNoWorkerSqlRole = false;

function noWorkerSqlRole(extName: string): Error {
  if (!_warnedNoWorkerSqlRole) {
    _warnedNoWorkerSqlRole = true;
    console.warn(
      '[worker-host] worker SQL is refused: this engine may SET neither zveltio_worker nor ' +
        'zveltio_rls, and will not run a worker extension query as its own role. Run ' +
        'scripts/bootstrap-db-role.sh as a superuser, then restart.',
    );
  }
  return new Error(
    `Worker SQL refused for "${extName}": no database role to run it as (zveltio_worker or ` +
      'zveltio_rls must exist and be SET-able by the engine role; see scripts/bootstrap-db-role.sh).',
  );
}

type Reserved = Awaited<ReturnType<RawPool['reserve']>>;

/**
 * A reserved connection in a transaction set up for `extName`'s SQL, as the
 * caller in `scope`. On failure it is rolled back and released.
 */
async function openWorkerTxn(extName: string, scope?: InvokeScope): Promise<Reserved> {
  const tenantId = scope?.tenantId;
  const { getActiveBunPool } = await import('../db/bun-sql-dialect.js');
  const pool = getActiveBunPool();
  if (!pool) throw new Error('BunSQL pool not initialized — host cannot run worker queries');
  const reserved = await pool.reserve();
  try {
    // Everything below runs in a transaction so the role and the tenant GUC are
    // `SET LOCAL` and unwind themselves — on COMMIT, on ROLLBACK, and on any
    // error in between.
    //
    // They used to be session settings reset in `finally`, with every reset
    // written `.catch(() => undefined)`. That is best-effort cleanup on a
    // connection going straight back into the pool, and the comment there
    // already named the price: "leaking either would silently cap or
    // de-privilege unrelated engine queries that reuse this connection."
    //
    // It did. Under concurrency, Better Auth borrowed a connection this bridge
    // had left as `zveltio_rls` and answered `permission denied for table
    // session` — 401s and 500s on requests that had nothing to do with any
    // extension. The tenant GUC leaks by the same path and is the worse half: a
    // pooled connection carrying another tenant's id scopes whatever runs on it
    // next, outside a tenant transaction, to that tenant.
    //
    // `SET LOCAL` cannot leak, because Postgres unwinds it. Statements that
    // would end this transaction early are refused by `assertWorkerSqlAllowed`.
    await reserved.unsafe('BEGIN');
    // Per statement: a request's transaction (RFC step 8) runs many.
    await reserved.unsafe(`SET LOCAL statement_timeout = '${WORKER_QUERY_TIMEOUT_S}s'`);
    await setWorkerRole(reserved, extName);
    if (tenantId) {
      // The tenant and the caller, from the host's own record — the settings
      // `withTenantIsolation` publishes for the request, so the row rules keyed
      // on the user apply here as they do to an inline extension's `ctx.db`.
      // Without them `zveltio.actor` was never `on`, every such rule stood down,
      // and the worker saw what an anonymous caller of the tenant sees.
      //
      // Deliberately NOT carried: the caller's exemption (`rls_bypass`) and a
      // reach wider than this tenant (`visible_tenants`/`ancestor_tenants`).
      // Both only widen, and this code is the extension the platform chose not
      // to trust; it keeps the single-tenant, rules-apply view it always had.
      // A reach NARROWER than the tenant is carried: a caller whose assignments
      // all lapsed sees NO_UNITS inline, and saw the whole tenant through here.
      //
      // Parameterised: `set_config` takes bind parameters where `SET` does not.
      const id = scope?.actor?.identity;
      await reserved.unsafe(
        `SELECT set_config('zveltio.current_tenant', $1, true),
                set_config('zveltio.user_id', $2, true),
                set_config('zveltio.user_email', $3, true),
                set_config('zveltio.user_role', $4, true),
                set_config('zveltio.user_roles', $5, true),
                set_config('zveltio.actor', $6, true),
                set_config('zveltio.rls_bypass', 'off', true),
                set_config('zveltio.collection_grants', $7, true),
                set_config('zveltio.collection_all', $8, true),
                set_config('zveltio.system_collections', '', true),
                set_config('zveltio.visible_tenants', $9, true)`,
        [
          tenantId,
          id?.userId ?? '',
          id?.email ?? '',
          id?.role ?? '',
          (id?.roles ?? []).join(','),
          // An anonymous request is an actor too: the tenant's `public` role (R1).
          id?.userId || id?.anonymous ? 'on' : 'off',
          // What collection permissions (R1) check — the caller's own grants, so a
          // worker's query gets no collection its caller could not touch.
          id?.collectionGrants ?? '',
          id?.collectionAll ? 'on' : 'off',
          scope?.noUnits ? NO_UNITS : '',
        ],
      );
    }
    return reserved;
  } catch (err) {
    await endWorkerTxn(reserved, false);
    throw err;
  }
}

/**
 * `SET LOCAL ROLE` to `extName`'s role on a connection in a transaction. With
 * `switching`, from another extension's role first: a worker-to-worker service
 * call joins its caller's request transaction (RFC step 8), and the callee's SQL
 * runs as the callee.
 */
async function setWorkerRole(
  conn: Pick<Reserved, 'unsafe'>,
  extName: string,
  switching = false,
): Promise<void> {
  // The pick runs as the login: `pg_has_role(current_user, …)` from another
  // extension's role answers for that role.
  if (switching) await conn.unsafe('SET LOCAL ROLE NONE');
  // `zveltio_worker`, not `zveltio_rls`. The latter holds SELECT, INSERT,
  // UPDATE and DELETE on every table in `public` — including Better-Auth's
  // `user`, `session`, `account`, `verification` and `twoFactor`, none of
  // which has RLS. This bridge exists to sandbox extension code the platform
  // has decided not to trust, and it was running under a role that could
  // read every live session token on the instance.
  //
  // `zveltio_worker` is granted collection tables only — by applyTenantRLS,
  // once FORCE RLS and the policy are on the table — and is
  // NOSUPERUSER/NOBYPASSRLS, so tenant isolation on `zvd_*` holds exactly
  // as it does for a request. The engine's own `zvd_*` metadata tables are
  // revoked at boot (reconcileTenantRLS).
  //
  // Where a managed Postgres would not let migration 001 create it, fall back
  // to `zveltio_rls` rather than take every worker extension down, and let the
  // allowlist in worker-sql-policy.ts be the layer that holds. ASKED which role
  // exists rather than attempting `SET ROLE` and catching: a refused statement
  // aborts this transaction, so the old `catch` fallback ran its second
  // `SET ROLE` — and then the extension's query — on an aborted transaction,
  // and every worker query on such a deployment failed with 25P02. Measured.
  //
  // No usable role is refused, never run as the engine's own login: that role
  // owns every table and, on a superuser, bypasses RLS — measured, a worker
  // under tenant A read tenant B's rows. Only a broken install gets here:
  // migration 001 creates both roles wherever it may (superuser, CREATEROLE),
  // and scripts/bootstrap-db-role.sh does it where it may not.
  const role = await pickWorkerSqlRole(conn, workerDbRoleFor(extName));
  if (!role) throw noWorkerSqlRole(extName);
  await conn.unsafe(`SET LOCAL ROLE ${role}`);
}

/**
 * End a transaction `openWorkerTxn` began and give the connection back clean.
 * Throws when COMMIT failed — after the cleanup, so nothing it wrote was kept.
 */
async function endWorkerTxn(reserved: Reserved, commit: boolean): Promise<void> {
  let failed: unknown;
  try {
    await reserved.unsafe(commit ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    failed = err;
    // ROLLBACK is what returns the connection clean. If even that fails the
    // connection is in an unknown state, and the one thing it must not be is
    // reused: a borrower inheriting a role or a tenant id is the failure this
    // block exists to prevent. Losing a connection is cheaper than handing out
    // a contaminated one.
    try {
      await reserved.unsafe('ROLLBACK');
    } catch {
      try {
        (reserved as unknown as { close?: () => void }).close?.();
      } catch {
        /* nothing left to try — the release below still drops our hold */
      }
    }
  }
  // A temp table the role created outlives the transaction on this pooled
  // connection, and pg_temp is searched first by the next borrower's
  // unqualified names. Only where boot could not take TEMPORARY from the role.
  if (!temporaryObjectsRestricted()) {
    try {
      await reserved.unsafe('DISCARD TEMP');
    } catch {
      (reserved as unknown as { close?: () => void }).close?.();
    }
  }
  reserved.release();
  if (commit && failed) throw failed;
}

/** Ceiling on a request's transaction across the bridge (RFC step 8). */
const REQUEST_TXN_TIMEOUT_MS = 30_000;
let requestTxnTimeoutMs = REQUEST_TXN_TIMEOUT_MS;

/**
 * The database transaction of one worker request (RFC extension-runner, step 8):
 * opened on the request's first bridged statement, held on one reserved
 * connection, ended once by `endRequestTxn` — committed when the handler
 * answered without throwing, rolled back otherwise, on the hard timeout, and
 * when the worker dies or is stopped mid-request.
 *
 * It used to be one transaction per statement, so a request that wrote twice and
 * failed in between kept the first write: a burned invoice number, an orphan
 * contact (docs/engine/rfc-extension-runner-experiment.md §4).
 */
interface RequestTxn {
  conn?: Reserved;
  /** The extension whose role the transaction is SET to now. */
  ext?: string;
  /**
   * Open `db.transaction()` savepoints, innermost last, each with the extension
   * that opened it; named `zv_sp_<depth>` by the host.
   */
  savepoints: string[];
  /** Statements run one at a time, in arrival order, on the one connection. */
  tail: Promise<unknown>;
  /** Why statements are refused from now on. */
  over?: string;
  closing?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
}

function newRequestTxn(): RequestTxn {
  return { savepoints: [], tail: Promise.resolve() };
}

/** Run `fn` on the request's transaction, opening it on the first statement. */
function inRequestTxn<T>(
  txn: RequestTxn,
  extName: string,
  scope: InvokeScope,
  fn: (conn: Reserved) => Promise<T>,
): Promise<T> {
  const run = txn.tail.then(async () => {
    if (txn.over) throw new Error(`the database transaction is over (${txn.over})`);
    if (!txn.conn) {
      txn.conn = await openWorkerTxn(extName, scope);
      txn.ext = extName;
      const ms = requestTxnTimeoutMs;
      txn.timer = setTimeout(
        () => void endRequestTxn(txn, false, `rolled back: timed out after ${ms} ms`),
        ms,
      );
    } else if (txn.ext !== extName) {
      // Cleared first: a failed switch must not leave a statement to run as
      // whatever role the switch stopped at.
      txn.ext = undefined;
      await setWorkerRole(txn.conn, extName, true);
      txn.ext = extName;
    }
    return fn(txn.conn);
  });
  txn.tail = run.catch(() => undefined);
  return run;
}

/**
 * End the request's transaction, once: COMMIT with `commit`, else ROLLBACK, and
 * release the connection. Resolves true when what the request wrote stands —
 * committed, or nothing was written — and false when it was rolled back, here
 * or earlier (the timeout), or COMMIT failed. Later calls get the first answer.
 */
function endRequestTxn(txn: RequestTxn, commit: boolean, why?: string): Promise<boolean> {
  if (txn.closing) return txn.closing;
  txn.over = why ?? (commit ? 'committed' : 'rolled back');
  clearTimeout(txn.timer);
  txn.closing = txn.tail.then(async () => {
    const conn = txn.conn;
    if (!conn) return commit;
    try {
      await endWorkerTxn(conn, commit);
      return commit;
    } catch (err) {
      console.error('[worker-host] a request transaction failed to commit:', err);
      return false;
    }
  });
  return txn.closing;
}

/**
 * `db.transaction()` in a worker: a savepoint in its request's transaction,
 * named here — the worker never sends transaction-control text.
 */
async function requestSavepoint(
  extName: string,
  scope: InvokeScope | undefined,
  op: 'begin' | 'release' | 'rollback',
): Promise<unknown[]> {
  if (!scope?.txn) {
    throw new Error(
      'no database transaction is open to take a savepoint in: outside a request only ' +
        'db.transaction().execute() opens one',
    );
  }
  const txn = scope.txn;
  return inRequestTxn(txn, extName, scope, async (conn) => {
    if (op === 'begin') {
      await conn.unsafe(`SAVEPOINT zv_sp_${txn.savepoints.length + 1}`);
      txn.savepoints.push(extName);
      return [];
    }
    // Only the extension that opened the innermost savepoint ends it: another
    // one could otherwise roll back work it does not own.
    if (txn.savepoints.at(-1) !== extName) throw new Error('no db.transaction() is open');
    const name = `zv_sp_${txn.savepoints.length}`;
    if (op === 'rollback') {
      // ROLLBACK TO also undoes every SET LOCAL ROLE since the savepoint, so the
      // role the connection is in may no longer be `txn.ext`'s: forget it, and
      // the next statement sets its own.
      txn.ext = undefined;
      await conn.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    }
    await conn.unsafe(`RELEASE SAVEPOINT ${name}`);
    txn.savepoints.pop();
    return [];
  });
}

/**
 * A `db.transaction()` callback outside a request — `register()`, a timer, an
 * event delivery, a service an inline caller invoked (owner decision 4): the
 * host's own transaction, on a connection of its own, as the scope a lone
 * statement of the same work runs as (the invocation's tenant and caller, or
 * none). `begin` opens it, the outermost `release` commits it, the outermost
 * `rollback` rolls it back; nested ones are savepoints, as in a request. The
 * request's hard timeout and its role and GUC hygiene apply unchanged.
 */
interface HostTxn {
  txn: RequestTxn;
  /** The invocation it was opened in; every statement on it must name the same. */
  requestId?: string;
}

/** Host transactions one worker may hold open at once: each holds a pooled connection. */
const MAX_HOST_TXNS = 4;

async function hostTxnStatement(
  managed: ManagedWorker,
  msg: Extract<WorkerToHostMessage, { type: 'db:query' }>,
  id: string,
  scope: InvokeScope | undefined,
): Promise<unknown[]> {
  managed.hostTxns ??= new Map();
  const { savepoint: op } = msg;
  let open = managed.hostTxns.get(id);
  if (open && open.requestId !== msg.requestId) {
    throw new Error(`database transaction ${id} belongs to other work`);
  }
  if (!open) {
    // Ended already (timed out, its worker work over): nothing left to undo.
    if (op === 'rollback') return [];
    if (op !== 'begin') throw new Error(`database transaction ${id} is over (or was never opened)`);
    for (const [k, t] of managed.hostTxns) if (t.txn.over) managed.hostTxns.delete(k);
    if (managed.hostTxns.size >= MAX_HOST_TXNS) {
      throw new Error(
        `db.transaction() refused: "${managed.name}" already holds ${MAX_HOST_TXNS} open ` +
          'transactions outside a request',
      );
    }
    open = { txn: newRequestTxn(), requestId: msg.requestId };
    managed.hostTxns.set(id, open);
    try {
      // BEGIN now, so the hard timeout counts from the callback's start.
      return await inRequestTxn(
        open.txn,
        managed.name,
        scope ?? { tenantId: null },
        async () => [],
      );
    } catch (err) {
      endHostTxn(managed, id);
      throw err;
    }
  }
  const inTxn = { tenantId: null, ...scope, txn: open.txn };
  if (!op) return runRawWithParams(managed.name, msg.sql, msg.params, inTxn);
  if (op === 'begin' || open.txn.savepoints.length > 0) {
    return requestSavepoint(managed.name, inTxn, op);
  }
  managed.hostTxns.delete(id);
  const commit = op === 'release';
  const earlier = open.txn.over;
  if (!(await endRequestTxn(open.txn, commit)) && commit) {
    throw new Error(
      'the database transaction could not be committed; nothing it wrote was kept ' +
        `(${earlier ?? 'COMMIT failed'})`,
    );
  }
  return [];
}

/** Roll back and forget a host transaction, if it is still open. */
function endHostTxn(managed: ManagedWorker, id: string, why?: string): void {
  const open = managed.hostTxns?.get(id);
  if (!open) return;
  managed.hostTxns?.delete(id);
  void endRequestTxn(open.txn, false, why);
}

/**
 * One statement for `extName`: inside its request's transaction when it serves a
 * route (RFC step 8), else in a transaction of its own — background work
 * (`register()`, timers, events, a service an inline caller invoked) has no
 * request whose answer could commit it, unless it opened one (`hostTxnStatement`).
 */
async function runRawWithParams(
  extName: string,
  sql: string,
  params: unknown[],
  scope?: InvokeScope,
): Promise<unknown[]> {
  assertWorkerSqlAllowed(extName, sql, await workerSqlEngineTables());
  const { encodeArrayParams } = await import('../db/bun-sql-dialect.js');
  const args = params.length > 0 ? encodeArrayParams(params) : undefined;
  const exec = (conn: Reserved) => conn.unsafe(sql, args) as Promise<unknown[]>;
  if (scope?.txn) return inRequestTxn(scope.txn, extName, scope, exec);
  const reserved = await openWorkerTxn(extName, scope);
  let rows: unknown[];
  try {
    rows = await exec(reserved);
  } catch (err) {
    await endWorkerTxn(reserved, false);
    throw err;
  }
  await endWorkerTxn(reserved, true);
  return rows;
}
