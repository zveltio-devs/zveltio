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
import { pgErrorFields } from './worker-extension-protocol.js';
import {
  type ExtensionChannel,
  extensionTransport,
  spawnProcessRunner,
  connectRunner,
  FrameTooLargeError,
} from './worker-extension-transport.js';
import {
  callableDeps,
  reachableOwner,
  type ServiceDeps,
  serviceCallRefusal,
  serviceRegistry,
} from './service-registry.js';
import { activePoolMax, getDb, type Database } from '../db/index.js';
import { sqlState } from '../db/bun-sql-quirks.js';
import { CompiledQuery } from 'kysely';
import { Turns, transactionTurns } from '../db/trx-sequencer.js';
import type { RawPool } from '../db/bun-sql-dialect.js';
import {
  CREDENTIAL_HEADERS,
  activationMiddlewareFor,
  extensionLoader,
  guardEventHandler,
} from './extensions/index.js';
import { compilePattern, extensionRequestRefused } from '../middleware/extension-auth-gate.js';
import { ProblemException, problem, problemOnError } from './problem.js';
import { ENGINE_EVENT_NAMESPACES, engineEvents } from './runtime/index.js';
import {
  assertNoWrittenByActionsWrite,
  assertWorkerSqlAllowed,
  workerDbRoleFor,
  workerSqlEngineTables,
} from './extensions/index.js';
import {
  NO_UNITS,
  beforeRequestTransactionEnds,
  describeDenial,
  getCurrentDomainOrNull,
  getCurrentTenantTrx,
  getCurrentTrxTenant,
  requestTransactionState,
  getRequestActor,
  getResolvedMembership,
  getUserRoles,
  issuerSettings,
  type RequestActor,
  runOutsideTenantContext,
  runWithDomain,
  runWithoutTenantTrx,
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
  /**
   * The request's own session, looked up with its own headers. A service call's
   * holds only the caller's user id (`invokeWorkerService`).
   */
  session?: () => Promise<unknown>;
  /**
   * The route request's database transaction (RFC step 8). Shared with a
   * worker service it calls, which joins it as an inline service would.
   */
  txn?: RequestTxn;
  /**
   * Where in `txn` this invocation's statements take their turn: inside the
   * caller's `db.transaction()` scope the call was made in, else at its
   * caller's level; a route's are at the top.
   */
  within?: RunIn;
}

type RunIn = <R>(fn: () => R) => R;
const direct: RunIn = (fn) => fn();

/**
 * The request transaction an inline service runs in when a worker request
 * called it, so a worker service it calls in turn joins that too.
 */
const inlineServiceTxn = new AsyncLocalStorage<Pick<InvokeScope, 'txn' | 'within'>>();

/**
 * What a worker's `ctx` asks the host for (RFC extension-runner, step 7): the
 * members `buildRestrictedContext` gives the same extension inline, so a host
 * call is answered by the inline code itself.
 */
export interface WorkerCtxSource {
  config?: unknown;
  checkPermission?: (userId: string, resource: string, action: string) => Promise<boolean>;
  auth?: { api: { getSession(args: { headers: Headers }): Promise<unknown> } };
  /**
   * Public route pattern → credential headers the worker receives: the manifest's
   * `forwardCredentials` only once an operator approved all of it (register.ts),
   * never the manifest's own claim.
   */
  forwardCredentials?: Record<string, readonly string[]>;
  /** The manifest's own `forwardCredentials`, against which an approval change is re-resolved. */
  declaredForwardCredentials?: Record<string, string[]>;
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

/**
 * Session fields a worker may hold: the `session` table's columns minus
 * `token`. An allowlist, so a field a Better Auth plugin adds later (another
 * credential, say) stays in the engine until it is named here.
 */
const WORKER_SESSION_FIELDS = [
  'id',
  'userId',
  'expiresAt',
  'createdAt',
  'updatedAt',
  'ipAddress',
  'userAgent',
] as const;

/**
 * The request's session as a worker may hold it: Better Auth's, without
 * `session.token`. The token is the session's credential, which the worker is
 * never handed (`workerRequestHeaders`); approved forwarding passes the
 * header itself, on its route, and nothing more.
 */
function withoutSessionToken(found: unknown): unknown {
  const s = found as { session?: unknown } | null;
  if (!s?.session || typeof s.session !== 'object') return found;
  const all = s.session as Record<string, unknown>;
  const session = Object.fromEntries(
    WORKER_SESSION_FIELDS.filter((k) => k in all).map((k) => [k, all[k]]),
  );
  return { ...s, session };
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
      `\`zveltio ext-runner setup\`; Helm: extRunner.enabled; one container — Fly.io, ` +
      `Railway, Render, docker run: start the image as root, the Dockerfile's default ` +
      `target or \`--user 0:0\`).`,
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
  ) {
    // Each worker mirrors the registry's names and owners, so its
    // `ctx.services.has/get/list` answer synchronously, as inline. One snapshot
    // per tick, however many services a load registers.
    let queued = false;
    this.resyncServices = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const services = serviceRegistry.entries();
        for (const managed of this.workers.values()) {
          if (managed.stopped) continue;
          // A channel closing under it must not fail the registration that
          // triggered this; its next start sends the registry with `init`.
          try {
            this.post(managed, {
              type: 'services:snapshot',
              id: rpcId('svcs'),
              services,
              mayCall: [...managed.mayCall],
            });
          } catch {
            /* ended channel */
          }
        }
      });
    };
    serviceRegistry.onChange(this.resyncServices);
  }

  /**
   * Send every worker the registry and its own `ServiceDeps` again, once per
   * tick. The registry's changes call it; so does a dependent's `ServiceDeps`
   * turning an upgraded optional dependency callable, which changes no service.
   */
  readonly resyncServices: () => void;

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

  runningNames(): string[] {
    return [...this.workers.keys()];
  }

  /** Per extension: the restart in progress, so two changes do not interleave stop and start. */
  private forwardRestarts = new Map<string, Promise<void>>();

  /**
   * Hand the running worker what `resolve` makes of its manifest's
   * `forwardCredentials` from now on. When that differs from what it was
   * handed, the worker is restarted, not patched: a withdrawal must also drop
   * whatever the worker kept of the credentials it already received.
   *
   * `resolve` reads the approval inside this extension's queue, so the change
   * asked for last reads last and lands last. Read before queueing, an older
   * read that came back late was applied after a withdrawal.
   */
  setForwardCredentials(
    extName: string,
    resolve: (declared: Record<string, string[]>) => Promise<Record<string, readonly string[]>>,
  ) {
    const run = async () => {
      if (!this.workers.has(extName)) return;
      const forward = await resolve(
        this.workers.get(extName)?.source?.declaredForwardCredentials ?? {},
      );
      // After the read: a crash respawn may have swapped it, a stop removed it.
      const managed = this.workers.get(extName);
      if (!managed) return;
      const source = managed.source ?? {};
      if (JSON.stringify(source.forwardCredentials ?? {}) === JSON.stringify(forward)) return;
      // Set first: should the spawn below fail, crash recovery retries with it.
      managed.source = { ...source, forwardCredentials: forward };
      this.retire(managed);
      try {
        const fresh = await this.replace(managed);
        console.log(
          `🔑 Worker "${extName}" restarted for a forward approval change (gen ${fresh.workerGeneration})`,
        );
      } catch (err) {
        this.scheduleRespawn(managed, `forward approval restart: ${(err as Error).message}`);
        throw err;
      }
    };
    return this.enqueueForward(extName, run);
  }

  private enqueueForward(extName: string, run: () => Promise<void>): Promise<void> {
    const next = (this.forwardRestarts.get(extName) ?? Promise.resolve()).then(run, run);
    this.forwardRestarts.set(extName, next);
    return next;
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
    // Outside every tenant context: a message is answered as the request it
    // names (`requestScope`) or as no one. The handler otherwise ran in the
    // context the worker was spawned or respawned in — an enable request's — and
    // a timer's emit in the worker delivered listeners as that request's tenant
    // and user.
    worker.onmessage = (e) =>
      runOutsideTenantContext(() => this.handleWorkerMessage(managed, e.data));
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
        mayCall: [...managed.mayCall],
        services: serviceRegistry.entries(),
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
    if (this.workers.get(managed.name) !== managed) return;
    managed.lastCrashAt = Date.now();
    this.retire(managed);
    const prevBackoff = this.respawnBackoff.get(managed.name) ?? 500;
    const backoff = Math.min(prevBackoff * 2, MAX_RESPAWN_BACKOFF_MS);
    this.respawnBackoff.set(managed.name, backoff);
    console.warn(`🔄 Respawning worker "${managed.name}" in ${backoff}ms — reason: ${reason}`);
    // In the forward queue: a respawn already replacing the worker with the old
    // source would otherwise reject a forward change's replace and keep its map.
    setTimeout(() => this.enqueueForward(managed.name, respawn), backoff);
    const respawn = async () => {
      if (managed.stopped) return;
      if (this.workers.get(managed.name) !== managed) return;
      try {
        const fresh = await this.replace(managed);
        // Reset backoff on successful respawn
        this.respawnBackoff.set(managed.name, 500);
        console.log(`✓ Worker "${managed.name}" respawned (gen ${fresh.workerGeneration})`);
      } catch (err) {
        console.error(`❌ Respawn failed for "${managed.name}":`, (err as Error).message);
        // Schedule another attempt with further backoff
        this.scheduleRespawn(managed, `respawn-failed: ${(err as Error).message}`);
      }
    };
  }

  /** End a worker that is to be replaced: in the map, answering nothing, until it is. */
  private retire(managed: ManagedWorker): void {
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
  }

  /**
   * Spawn the next generation of a retired worker under the proxy routes it
   * already has: they cannot be mounted again once the app has served a
   * request, and they read the running worker on every request.
   */
  private async replace(managed: ManagedWorker): Promise<ManagedWorker> {
    const fresh = await this.spawn(
      managed.name,
      managed.extDir,
      managed.bundleEntry,
      managed.workerGeneration + 1,
      managed.dependencies,
      managed.mayCall,
      managed.source ?? {},
    );
    // Stopped (disabled, unloaded) while this one spawned: it must not come back.
    if (managed.stopped || this.workers.get(managed.name) !== managed) {
      fresh.worker.terminate();
      throw new Error(`worker "${managed.name}" was stopped during its restart`);
    }
    // Carry over the proxy-mount + bookkeeping; the old ManagedWorker
    // is replaced in the registry by the new one.
    fresh.proxyUnmount = managed.proxyUnmount;
    fresh.totalRequests = managed.totalRequests;
    fresh.lastCrashAt = managed.lastCrashAt;
    fresh.lastHangAt = managed.lastHangAt;
    fresh.bundleHashPrefix = managed.bundleHashPrefix;
    this.workers.set(managed.name, fresh);
    fresh.heartbeatTimer = setInterval(() => this.heartbeat(fresh), HEARTBEAT_INTERVAL_MS);
    return fresh;
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
          ? await hostTxnStatement(
              managed,
              msg,
              msg.txn,
              scope,
              hostTxnCap(activePoolMax(), this.workers.size),
            )
          : msg.savepoint
            ? await requestSavepoint(managed.name, scope, msg.savepoint, scopeKey(msg))
            : await runRawWithParams(
                managed.name,
                msg.sql,
                msg.params,
                scope,
                scope && levelOf(scope, scopeKey(msg)),
              );
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
        // detail/constraint/table/column: what names the failing row or key.
        pg: pgErrorFields(err),
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
      // The callee runs where the caller made the call: in the request's
      // transaction, inside the caller's `db.transaction()` if it made it there.
      const within = scope.txn ? levelOf(scope, scopeKey(msg)) : undefined;
      if (ownerWorker && ownerWorker.name !== managed.name) {
        const result = await this.invokeWorkerService(ownerWorker, msg.name, msg.args, {
          ...scope,
          within,
        });
        this.post(managed, { type: 'service:ok', id: msg.id, result });
        return;
      }
      // Fall back to inline registry (host-side services).
      const impl = serviceRegistry.get<(...args: unknown[]) => unknown>(name);
      if (typeof impl !== 'function') throw new Error(`service "${msg.name}" is not callable`);
      const call = () =>
        inlineServiceTxn.run({ txn: scope.txn, within }, () => Promise.resolve(impl(...msg.args)));
      // The context an inline extension's code has while serving a request of
      // that tenant — the domain `tenantMiddleware` opens and the tenant
      // transaction inside it — so the service's `ctx.db` and its permission
      // checks resolve the caller's tenant — and the row rules keyed on that
      // user. Inside the request's async context, so the API key the gate
      // admitted is the one the service's `checkPermission` answers for — and
      // passes on to a worker service it calls (`callerScope`).
      //
      // In that request's own tenant transaction, as when an inline route calls
      // it, so what it writes is kept or undone with the request. It used to open
      // a transaction of its own, which committed when the service returned: a
      // worker route that threw after the call kept the service's rows. Only
      // where the request holds none (an event delivery) does it open one, as
      // that caller, for itself. No request, no tenant: unchanged.
      // In a joined request transaction, at the caller's place in its turns: a
      // call made inside the worker's own `db.transaction()` runs in it, as the
      // statements beside it do, rather than wait for it to end.
      const run = (scope.txn?.joined && within) || scope.run || direct;
      const result = tenantId
        ? await run(() =>
            getCurrentTenantTrx() && getCurrentTrxTenant() === tenantId
              ? call()
              : runWithDomain(tenantId, () => withTenantIsolation(tenantId, call, actor)),
          )
        : await run(call);
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
      // In a joined request transaction, at the caller's place in its turns: a
      // query made for a call inside the worker's `db.transaction()` runs in it,
      // rather than wait for the scope that is waiting for this answer.
      const run =
        (scope?.txn?.joined && levelOf(scope, scopeKey(msg))) ||
        scope?.run ||
        (<R>(fn: () => R) => fn());
      const session = async () => (scope?.session ? await run(scope.session) : null) ?? null;
      const who = async () =>
        scope?.user?.id ?? ((await session()) as { user?: { id?: string } } | null)?.user?.id;
      const [a, b, c] = msg.args;
      const { op } = msg;
      let result: unknown;
      switch (op) {
        case 'getSession':
          result = withoutSessionToken(await session());
          break;
        case 'checkPermission': {
          const check = managed.source?.checkPermission;
          result =
            !!check &&
            typeof a === 'string' &&
            a === (await who()) &&
            (await run(() => check(a, String(b), String(c))));
          break;
        }
        case 'getUserRoles':
          result =
            typeof a === 'string' && a === (await who()) ? await run(() => getUserRoles(a)) : [];
          break;
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
        case 'waitForService':
          // The inline scope's rules (refused owners at once); the value stays here.
          await serviceRegistry
            .scope(managed.name, managed.mayCall)
            .waitFor(String(a), typeof b === 'number' ? b : undefined);
          result = true;
          break;
        case 'unregisterService':
          if (managed.registeredServices.delete(String(a))) {
            serviceRegistry.unregisterAs(managed.name, String(a));
          }
          break;
        case 'describeDenial':
          result = await run(() =>
            describeDenial(getCurrentTenantTrx() ?? getDb(), String(a), String(b)),
          );
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
   * (`guardEventHandler`, as an inline listener). The listener's second
   * argument names that tenant: the engine's record, not whatever the
   * emitter's payload claims. The caller is `callerScope`'s: the emitting
   * request's user, so the listener's `checkPermission` answers for that user as
   * an inline listener's (run in the emitter's async context) does — and for no
   * one when the event was emitted outside a request. No session: a user id,
   * never the request's credentials. Nor the emitter's transaction: delivery
   * runs after the emitter's `await`, often past its COMMIT, and a host call
   * answered in it met "Transaction is already committed".
   */
  private subscribe(managed: ManagedWorker, event: string, key: string): void {
    const deliver = (payload: unknown) => {
      const scope = runWithoutTenantTrx(callerScope);
      return this.invokeWorkerService(
        managed,
        key,
        [payload, { tenantId: scope.tenantId }],
        scope,
        'event:deliver',
      ).catch((err: Error) =>
        console.error(`[worker:${managed.name}] listener for "${event}" failed: ${err.message}`),
      );
    };
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
   *
   * The service's `getSession` is the caller's user id and nothing more —
   * `{ user: { id } }` for the id its `checkPermission` answers for, or null
   * (owner decision 2026-10-24). Never the caller's session: called from a
   * worker route, the scope carried that route's whole Better Auth session
   * into the callee; called inline, it carried none, and getSession was null
   * for a user checkPermission answered for.
   */
  private async invokeWorkerService(
    target: ManagedWorker,
    name: string,
    args: unknown[],
    scope: InvokeScope,
    type: 'service:invoke' | 'event:deliver' = 'service:invoke',
  ): Promise<unknown> {
    const invokeId = rpcId('inv-svc');
    // The caller's id as `handleHostCall`'s `who` resolves it: on a public route
    // the gate sets no user, and the route's own session names it.
    const callerId = async () => {
      if (scope.user?.id) return scope.user.id;
      const run = scope.run ?? (<R>(fn: () => R) => fn());
      const found = scope.session ? await run(scope.session) : null;
      return (found as { user?: { id?: string } } | null)?.user?.id;
    };
    target.invokeTenants.set(
      invokeId,
      type === 'service:invoke'
        ? {
            ...scope,
            session: async () => {
              const id = await callerId();
              return id ? { user: { id } } : null;
            },
          }
        : scope,
    );
    try {
      const reply = await new Promise<
        Extract<WorkerToHostMessage, { type: 'service:invoke:ok' | 'service:invoke:err' }>
      >((resolve, reject) => {
        invokeWaiters.set(invokeId, { expect: target.name, resolve, reject });
        setTimeout(
          () => {
            if (invokeWaiters.has(invokeId)) {
              invokeWaiters.delete(invokeId);
              reject(new Error(`service "${name}" call timeout`));
            }
            // In a request, the request's hard timeout, as a worker route's (ADR
            // 0009 §3). Outside one (an event delivery, a call from a timer) there
            // is no request transaction to bound: the fixed ceiling, and a host
            // transaction the callee opened ends on its own timer, not this one.
          },
          scope.txn ? requestTxnTimeoutMs : REQUEST_TXN_TIMEOUT_MS,
        );
        this.post(target, {
          type,
          id: invokeId,
          name,
          args,
          ...(scope.txn ? { requestTxn: true as const } : {}),
        });
      });
      if (reply.type === 'service:invoke:err') {
        throw new Error(reply.error ?? 'service call failed');
      }
      return reply.result;
    } finally {
      target.invokeTenants.delete(invokeId);
      // A scope the service left open outlives it: undone, so the caller's turn comes.
      if (scope.txn) await abandonScopes(scope.txn, target.name, invokeId);
      // And a host transaction it left un-awaited: its next statement would be
      // refused anyway (`handleDbQuery`), so it ends now instead of holding its
      // connection until the hard timeout.
      for (const [id, open] of target.hostTxns ?? []) {
        if (open.requestId === invokeId)
          endHostTxn(target, id, 'rolled back: its invocation is over');
      }
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
      serviceRegistry.scope(managed.name).register(msg.name, async (...args: unknown[]) => {
        const scope = callerScope();
        return this.invokeWorkerService(managed, msg.name, args, {
          ...scope,
          // Called by an inline service a worker request called: in that request.
          // Else by inline code serving a request: in that request's transaction.
          ...(inlineServiceTxn.getStore() ?? (await joinRequestTxn(scope))),
        });
      });
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
          error?: Error;
        }) => {
          const live = this.workers.get(managed.name);
          if (!live) return new Response('Extension worker is not running', { status: 503 });
          const bodyText = await c.req.raw.text().catch(() => '');
          // Drop the `/ext/<name>` segments rather than string-replacing the
          // name: Hono matched a percent-encoded name (`/ext/%70robe/x`), and
          // a replace left the whole path for the worker to 404 on.
          const subPath = `/${new URL(c.req.raw.url).pathname.split('/').slice(3).join('/')}`;
          // Read from the running worker, not closed over at mount: Hono cannot
          // unmount, so an earlier proxy on the same app answers a restarted
          // worker's requests and kept forwarding the set approved back then.
          const headers = workerRequestHeaders(
            c.req.raw.headers,
            new Set(
              Object.entries(live.source?.forwardCredentials ?? {})
                .filter(([pattern]) => compilePattern(pattern).test(subPath))
                .flatMap(([, h]) => h),
            ),
          );
          const id = rpcId('inv');
          const reqTenantId = (c.get('tenant') as { id?: string } | null)?.id ?? null;
          const user = (c.get('user') ?? undefined) as { id?: string } | undefined;
          const auth = live.source?.auth;
          const scope: InvokeScope = {
            ...currentScope(reqTenantId),
            user,
            run: AsyncLocalStorage.snapshot(),
            session: async () => auth?.api.getSession({ headers: c.req.raw.headers }) ?? null,
          };
          // The request's own tenant transaction, joined as a worker service an
          // inline route calls joins it: one connection, so an inline service
          // this route calls writes where the route reads, inside its
          // `db.transaction()` if it is in one. It used to be a transaction of
          // its own beside the tenant one: the route did not see the service's
          // rows, a scope that threw kept them, and the two committed apart.
          // A request with no tenant transaction still opens its own.
          const joined = await joinRequestTxn(scope);
          const txn = joined.txn ?? newRequestTxn();
          live.invokeTenants.set(id, { ...scope, ...joined, txn });
          live.inFlightRequests++;
          live.totalRequests++;
          try {
            const resp = await new Promise<RouteInvokeResponse>((resolve, reject) => {
              live.pendingInvokes.set(id, resolve);
              const timer = setTimeout(() => {
                if (live.pendingInvokes.has(id)) {
                  live.pendingInvokes.delete(id);
                  reject(new Error('worker route handler timeout (30s)'));
                }
                // The request's hard timeout, the same as its transaction's: a
                // joined transaction is the tenant's, ended only by the answer.
              }, requestTxnTimeoutMs);
              // A post that throws (a body encoding past MAX_FRAME_BYTES) used
              // to leave the pending entry and its timer behind for 30 s.
              try {
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
              } catch (err) {
                live.pendingInvokes.delete(id);
                clearTimeout(timer);
                reject(err);
              }
            });
            // The rule `tenantMiddleware` applies to an inline request: commit
            // unless the handler threw — whatever status it answered with.
            // Nor when an `admin` check refused it, even if the worker caught that.
            const commit = resp.type === 'route:ok' && !resp.threw && !extensionRequestRefused();
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
            // The caller's body is too big to hand over: theirs to fix, not a 500.
            if (err instanceof FrameTooLargeError) {
              return Response.json({ error: 'Request body too large' }, { status: 413 });
            }
            return new Response((err as Error).message, { status: 500 });
          } finally {
            // Timed out, or the worker died: nothing it wrote is kept. Nor what
            // the request's tenant transaction holds for it — an inline service
            // it called wrote there: as for an inline route that threw,
            // `tenantMiddleware` rolls it back on `c.error`, and keeps this answer.
            if (!(await endRequestTxn(txn, false))) {
              c.error ??= new Error('the worker request was rolled back');
            }
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
 * `currentScope` plus the request's user and async context, for a call into a
 * worker service (or an event delivered to a worker listener) from the caller's
 * own context: what an inline service called
 * there would see, so the service's `checkPermission` answers for that user (an
 * API key's id too) and no other. Read from the engine's record of the request
 * transaction, never from the caller; no request, no user. Without it a worker
 * service answered false for every user (owner decision L4).
 */
function callerScope(): InvokeScope {
  const scope = currentScope(getCurrentDomainOrNull());
  const id = scope.actor?.identity?.userId || scope.actor?.userId;
  return { ...scope, ...(id ? { user: { id } } : {}), run: AsyncLocalStorage.snapshot() };
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
    // The engine's own, whatever an extension is named.
    !ENGINE_EVENT_NAMESPACES.some((ns) => event.startsWith(ns)) &&
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
 *  - `SET LOCAL ROLE zveltio_worker` (or the extension's own role under it), so
 *    the query runs as a plain role rather than as the database owner. On a
 *    stock install the engine connects as the image's POSTGRES_USER, which is
 *    a SUPERUSER, so worker SQL previously ran with every privilege Postgres
 *    has and RLS did not apply to it at all. Under the
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
 * `zveltio_worker`, else null, and the bridge then refuses the query rather
 * than run it as the engine role (migration 001 creates `zveltio_worker`).
 *
 * Never `zveltio_rls`. It used to be the last fallback, and it is the request
 * role: the collection policy (migration 058) passes a statement with no actor
 * under it as the engine's own work, so a background hook — no tenant, no
 * caller — read the default tenant's rows of every collection, where under
 * `zveltio_worker` it reads none. Measured. It also holds `user`, `session` and
 * `account`, leaving the text allowlist as the only layer between an untrusted
 * extension and every session token.
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
              WHERE rolname IN ($1, 'zveltio_worker')
                AND pg_has_role(current_user, oid, 'SET')
              ORDER BY rolname = 'zveltio_worker' LIMIT 1) AS role`,
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
      '[worker-host] worker SQL is refused: this engine may not SET zveltio_worker, and ' +
        'will not run a worker extension query as its own role or as zveltio_rls. Run ' +
        'scripts/bootstrap-db-role.sh as a superuser, then restart.',
    );
  }
  return new Error(
    `Worker SQL refused for "${extName}": no database role to run it as (zveltio_worker ` +
      'must exist and be SET-able by the engine role; see scripts/bootstrap-db-role.sh).',
  );
}

type Reserved = Awaited<ReturnType<RawPool['reserve']>>;

/**
 * A reserved connection in a transaction set up for `extName`'s SQL, as the
 * caller in `scope`. On failure it is rolled back and released.
 */
async function openWorkerTxn(extName: string, scope?: InvokeScope): Promise<Reserved> {
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
    await applyWorkerSettings(reserved, extName, scope);
    return reserved;
  } catch (err) {
    await endWorkerTxn(reserved, false);
    throw err;
  }
}

/**
 * What `applyWorkerSettings` sets for a caller in `tenantId`: every name, so a
 * joined request transaction can put the caller's own values back after.
 */
function workerSettings(scope: InvokeScope | undefined): [string, string][] {
  if (!scope?.tenantId) return [];
  // The tenant and the caller, from the host's own record — the settings
  // `withTenantIsolation` publishes for the request, so the row rules keyed
  // on the user apply here as they do to an inline extension's `ctx.db`.
  // Without them `zveltio.actor` was never `on`, every such rule stood down,
  // and the worker saw what an anonymous caller of the tenant sees.
  //
  // Deliberately NOT carried: the caller's exemptions (`rls_bypass`,
  // `columns_all`) and a reach wider than this tenant
  // (`visible_tenants`). All only widen, and this code is the extension the platform chose not
  // to trust; it keeps the single-tenant, rules-apply view it always had.
  // A reach NARROWER than the tenant is carried: a caller whose assignments
  // all lapsed sees NO_UNITS inline, and saw the whole tenant through here.
  const id = scope.actor?.identity;
  const issuer = issuerSettings(id?.issuer);
  return [
    ['zveltio.current_tenant', scope.tenantId],
    ['zveltio.user_id', id?.userId ?? ''],
    ['zveltio.user_email', id?.email ?? ''],
    ['zveltio.user_role', id?.role ?? ''],
    ['zveltio.user_roles', (id?.roles ?? []).join(',')],
    // A key's issuer's column rules (095): only narrows, so it is carried.
    ['zveltio.issuer_role', id?.issuerRole ?? ''],
    // And its row rules (`getRlsFilters`): they only narrow too.
    ['zveltio.issuer_rows', issuer.mode],
    ['zveltio.issuer_user_id', issuer.userId],
    ['zveltio.issuer_user_email', issuer.email],
    ['zveltio.issuer_user_role', issuer.role],
    ['zveltio.issuer_user_roles', issuer.roles],
    // An anonymous request is an actor too: the tenant's `public` role (R1).
    ['zveltio.actor', id?.userId || id?.anonymous ? 'on' : 'off'],
    ['zveltio.rls_bypass', 'off'],
    ['zveltio.columns_all', 'off'],
    // What collection permissions (R1) check — the caller's own grants, so a
    // worker's query gets no collection its caller could not touch.
    ['zveltio.collection_grants', id?.collectionGrants ?? ''],
    ['zveltio.collection_all', id?.collectionAll ? 'on' : 'off'],
    ['zveltio.system_collections', ''],
    ['zveltio.visible_tenants', scope.noUnits ? NO_UNITS : ''],
  ];
}

/**
 * Set a transaction up for `extName`'s SQL as the caller in `scope`: its
 * statement timeout, its role (`switching` from another role) and the caller's
 * tenant settings, all `SET LOCAL`.
 */
async function applyWorkerSettings(
  conn: Pick<Reserved, 'unsafe'>,
  extName: string,
  scope: InvokeScope | undefined,
  switching = false,
): Promise<void> {
  // Per statement: a request's transaction (RFC step 8) runs many.
  await conn.unsafe(`SET LOCAL statement_timeout = '${WORKER_QUERY_TIMEOUT_S}s'`);
  await setWorkerRole(conn, extName, switching);
  const settings = workerSettings(scope);
  if (settings.length === 0) return;
  // Parameterised: `set_config` takes bind parameters where `SET` does not.
  await conn.unsafe(
    `SELECT ${settings.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(', ')}`,
    settings.flat(),
  );
}

/**
 * One statement of `extName`'s in a request transaction it joined, in its
 * window: the caller's role and settings read, the worker's set — what an
 * inline extension's statement gets (`asExtensionDbRole`). The window stays
 * open for the same invocation's next statement and is put back
 * (`releaseWindow`) before anything else runs on the connection: another
 * extension's statement, a savepoint, or any statement Kysely sends there
 * (`transactionTurns`). Restored after every statement, a worker route
 * paid seven round trips for each one where its own transaction paid one.
 * The request's turn is held throughout (`inRequestTxn`), so nothing of the
 * caller's runs inside it. A failed statement aborted the transaction (or the
 * savepoint around it), whose rollback restores the caller's settings.
 */
async function joinedStatement<T>(
  conn: Pick<Reserved, 'unsafe'>,
  extName: string,
  scope: InvokeScope,
  run: () => Promise<T>,
): Promise<T> {
  const txn = scope.txn as RequestTxn;
  let out: T;
  try {
    if (txn.window?.scope !== scope) {
      await releaseWindow(txn);
      // Complete only because the worker cannot change a setting itself:
      // `assertWorkerSqlAllowed` refuses SET, RESET and `set_config` in any
      // spelling before a statement gets here, so the settings this window
      // changes are the ones it applies. Admit any of those in the policy and
      // this list must grow. (`SET TRANSACTION`, which it admits, cannot raise a
      // privilege: at most it makes the caller's own request read-only.)
      const names = ['role', 'statement_timeout', ...workerSettings(scope).map(([n]) => n)];
      const [saved] = (await conn.unsafe(
        `SELECT json_object_agg(n, coalesce(current_setting(n, true), ''))::text AS s
           FROM unnest($1::text[]) AS n`,
        [names],
      )) as { s: string }[];
      // Recorded before the worker's settings go on, so a failure halfway puts
      // the caller's back.
      txn.window = { scope, saved: saved?.s ?? '{}' };
      await applyWorkerSettings(conn, extName, scope, true);
    }
    out = await run();
    if (!temporaryObjectsRestricted()) await conn.unsafe('DISCARD TEMP');
  } catch (err) {
    await releaseWindow(txn).catch(() => undefined);
    throw err;
  }
  return out;
}

/** Put the caller's settings back on a joined transaction, if a worker's window is open. */
async function releaseWindow(txn: RequestTxn): Promise<void> {
  const open = txn.window;
  if (!open || !txn.conn) return;
  // Cleared before the restore: a failed restore aborts the transaction
  // (Postgres), and SET LOCAL reverts with it, so nothing runs in the window.
  txn.window = undefined;
  await txn.conn.unsafe(
    `SELECT set_config(k, v, true) FROM json_each_text($1::text::json) AS t(k, v)`,
    [open.saved],
  );
}

/**
 * The request transaction a worker service called from inline code joins: the
 * request's own tenant transaction (`tenantMiddleware`), one per request,
 * ordered by its turns (`db/trx-sequencer.ts`) with the caller's statements and
 * `db.transaction()` scopes. Nothing outside a request's transaction — boot,
 * timers, events, jobs — and nothing once the request is ending.
 */
const joinedTxns = new WeakMap<object, Promise<RequestTxn>>();

async function joinRequestTxn(scope: InvokeScope): Promise<Pick<InvokeScope, 'txn' | 'within'>> {
  const trx = getCurrentTenantTrx();
  if (!trx || !scope.tenantId || getCurrentTrxTenant() !== scope.tenantId) return {};
  // A call made once the request is ending (or by a timer it left behind) is
  // refused, as inline code on a committed transaction is: run on its own
  // connection it would escape the request's rollback.
  const state = requestTransactionState();
  if (state === 'none') return {};
  if (state === 'over') {
    throw new Error("the request's transaction is over; a worker service cannot join it");
  }
  let pending = joinedTxns.get(trx);
  // Cached as a promise before any await: two first calls under `Promise.all`
  // share one joined transaction (one set of savepoint names on the connection).
  if (!pending) {
    pending = openJoinedTxn(trx);
    joinedTxns.set(trx, pending);
  }
  const txn = await pending;
  // At the caller's place in the turns: inside its `db.transaction()` if it is in one.
  return { txn, within: scope.run };
}

async function openJoinedTxn(trx: Database): Promise<RequestTxn> {
  const joined: RequestTxn = { ...newRequestTxn(), joined: true };
  const on = await transactionTurns(trx);
  // Every transaction `getDb()` opens is sequenced; one that is not cannot be
  // shared safely, and the call is refused rather than run beside it.
  if (!on) throw new Error("the request's transaction cannot be joined by a worker service");
  joined.turns = on.turns;
  // Whatever else is sent on the connection runs at the caller's settings.
  on.beforeSend(() => releaseWindow(joined));
  joined.conn = {
    // The affected-row count as a reserved connection carries it (`count` on
    // the rows, read by `handleDbQuery`): the pg driver's rows are a plain
    // array, and an UPDATE or DELETE without RETURNING answered 0.
    unsafe: async (sql: string, params?: unknown[]) => {
      const { rows, numAffectedRows: n } = await on.send(CompiledQuery.raw(sql, params ?? []));
      return n === undefined || 'count' in rows ? rows : Object.assign(rows, { count: Number(n) });
    },
  } as unknown as Reserved;
  // Ends before the request's transaction does: what is still queued is refused,
  // so no statement of the worker's lands after it.
  if (!beforeRequestTransactionEnds(() => endRequestTxn(joined, true, 'its request is over'))) {
    throw new Error("the request's transaction cannot be joined by a worker service");
  }
  return joined;
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
  // ASKED which role is usable rather than attempting `SET ROLE` and catching:
  // a refused statement aborts this transaction, so the old `catch` fallback
  // ran its second `SET ROLE` — and then the extension's query — on an aborted
  // transaction, and every worker query on such a deployment failed with 25P02.
  // Measured.
  //
  // No usable role is refused — never run as the engine's own login, which owns
  // every table and, on a superuser, bypasses RLS (measured: a worker under
  // tenant A read tenant B's rows), and never as `zveltio_rls`, which the
  // collection policy treats as the engine when no actor is set (measured: a
  // no-tenant worker query read the default tenant's rows; see
  // pickWorkerSqlRole). Only a broken install gets here: migration 001 creates
  // `zveltio_worker` wherever it may (superuser, CREATEROLE), and
  // scripts/bootstrap-db-role.sh does it where it may not.
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
  /**
   * An inline request's own tenant transaction, joined by a worker service it
   * called (`joinRequestTxn`): never opened, switched or ended here.
   */
  joined?: true;
  /**
   * Joined only: the invocation whose worker settings are on the connection now,
   * and the caller's they replaced (`joinedStatement`).
   */
  window?: { scope: InvokeScope; saved: string };
  /** The extension whose role the transaction is SET to now. */
  ext?: string;
  /**
   * Open `db.transaction()` savepoints, innermost last, each with the extension
   * that opened it; named `zv_sp_<depth>` by the host. Depth names one scope
   * because the worker runs sibling scopes in turn (`turnsHere` in the runtime).
   */
  savepoints: string[];
  /** Statements run one at a time, in arrival order, on the one connection. */
  tail: Promise<unknown>;
  /**
   * The order they arrive in: an open `db.transaction()` scope runs alone, and
   * the request's other work — another extension's too, reached through a
   * service call — waits for it to end; work made inside it runs in it.
   */
  turns: Turns;
  /** Open scopes, by `scopeKey`. */
  scopes: Map<string, TxnScope>;
  /** Why statements are refused from now on. */
  over?: string;
  closing?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A `db.transaction()` scope open in a request's transaction, across every
 * worker that shares it. The runtime orders an invocation's own scopes; the
 * host orders them against the other invocations' work, which it alone sees.
 */
interface TxnScope {
  /** Runs its argument at this scope's level of `RequestTxn.turns`. */
  runIn: RunIn;
  /** Its savepoints open now: nested `db.transaction()` calls keep the id. */
  depth: number;
  /** Savepoints open below it when it began. */
  base: number;
  end: () => void;
}

/** The scope a worker message names: its invocation and its `db.transaction()` id. */
function scopeKey(msg: { requestId?: string; txn?: string }): string | undefined {
  return msg.requestId && msg.txn ? `${msg.requestId} ${msg.txn}` : undefined;
}

/** Where a statement of `scope`'s invocation in scope `key` takes its turn. */
function levelOf(scope: InvokeScope, key: string | undefined): RunIn | undefined {
  return (key && scope.txn?.scopes.get(key)?.runIn) || scope.within;
}

function newRequestTxn(): RequestTxn {
  return { savepoints: [], tail: Promise.resolve(), turns: new Turns(), scopes: new Map() };
}

/** Run `fn` on the request's transaction, opening it on the first statement. */
function inRequestTxn<T>(
  txn: RequestTxn,
  extName: string,
  scope: InvokeScope,
  fn: (conn: Reserved) => Promise<T>,
  at: RunIn = direct,
): Promise<T> {
  return at(() => txn.turns.run(() => onConnection(txn, extName, scope, fn)));
}

function onConnection<T>(
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
    } else if (!txn.joined && txn.ext !== extName) {
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
  // Work waiting for a scope that will not end now runs, and is refused.
  for (const key of [...txn.scopes.keys()]) closeScope(txn, key);
  txn.closing = txn.tail.then(async () => {
    const conn = txn.conn;
    // A joined transaction is its request's to end.
    if (!conn || txn.joined) return commit;
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
 * named here — the worker never sends transaction-control text. A scope `key`
 * names (one per `db.transaction()` id of an invocation; outside a request
 * there is none) runs alone from its `begin` to its outermost end: the request's
 * other work, from any extension, waits for it — and work made inside it, a
 * service the scope calls included, runs in it.
 *
 * Without that a worker service called beside the scope had its statements land
 * in the scope's savepoint and undone with it, and a scope of its own opened
 * there made the caller's RELEASE fail.
 */
async function requestSavepoint(
  extName: string,
  scope: InvokeScope | undefined,
  op: 'begin' | 'release' | 'rollback',
  key?: string,
): Promise<unknown[]> {
  if (!scope?.txn) {
    throw new Error(
      'no database transaction is open to take a savepoint in: outside a request only ' +
        'db.transaction().execute() opens one',
    );
  }
  const txn = scope.txn;
  const open = key ? txn.scopes.get(key) : undefined;
  if (key && !open && op === 'begin') return openScope(txn, extName, scope, key);
  try {
    await inRequestTxn(
      txn,
      extName,
      scope,
      (conn) => savepointOp(txn, extName, conn, op),
      open?.runIn ?? scope.within,
    );
  } catch (err) {
    // A failed RELEASE leaves the savepoint; the rollback that follows ends it.
    if (open && op === 'rollback' && --open.depth === 0) closeScope(txn, key as string);
    throw err;
  }
  if (open) {
    open.depth += op === 'begin' ? 1 : -1;
    if (open.depth === 0) closeScope(txn, key as string);
  }
  return [];
}

/** Open scope `key` once the request's work before it is done, and take its savepoint. */
function openScope(
  txn: RequestTxn,
  extName: string,
  scope: InvokeScope,
  key: string,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    void (scope.within ?? direct)(() =>
      txn.turns.exclusive(async () => {
        let end = () => {};
        const ended = new Promise<void>((r) => {
          end = r;
        });
        const runIn = AsyncLocalStorage.snapshot() as RunIn;
        txn.scopes.set(key, { runIn, depth: 1, base: txn.savepoints.length, end });
        try {
          await onConnection(txn, extName, scope, (conn) =>
            savepointOp(txn, extName, conn, 'begin'),
          );
        } catch (err) {
          closeScope(txn, key);
          reject(err);
          return;
        }
        resolve([]);
        await ended;
      }),
    );
  });
}

function closeScope(txn: RequestTxn, key: string): void {
  const open = txn.scopes.get(key);
  txn.scopes.delete(key);
  open?.end();
}

/**
 * Roll back the scopes invocation `requestId` left open when it ended — a
 * service that returned without awaiting its `db.transaction()` — so the
 * request's other work is not left waiting on them.
 */
async function abandonScopes(txn: RequestTxn, extName: string, requestId: string): Promise<void> {
  for (const [key, open] of txn.scopes) {
    if (!key.startsWith(`${requestId} `)) continue;
    const name = `zv_sp_${open.base + 1}`;
    await open
      .runIn(() =>
        txn.turns.run(() =>
          onConnection(txn, extName, { tenantId: null }, async (conn) => {
            txn.ext = undefined;
            await releaseWindow(txn);
            await conn.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
            await conn.unsafe(`RELEASE SAVEPOINT ${name}`);
            txn.savepoints.length = open.base;
          }),
        ),
      )
      .catch(() => undefined);
    closeScope(txn, key);
  }
}

/** One savepoint statement, for the extension that owns it. */
async function savepointOp(
  txn: RequestTxn,
  extName: string,
  conn: Reserved,
  op: 'begin' | 'release' | 'rollback',
): Promise<void> {
  // At the caller's settings, always: a ROLLBACK TO would otherwise put back
  // (or take away) a worker's window behind `txn.window`'s back.
  await releaseWindow(txn);
  if (op === 'begin') {
    await conn.unsafe(`SAVEPOINT zv_sp_${txn.savepoints.length + 1}`);
    txn.savepoints.push(extName);
    return;
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
}

/**
 * A `db.transaction()` callback outside a request — `register()`, a timer, an
 * event delivery, a service inline code called outside one (owner decision 4): the
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

/**
 * Host transactions one worker may hold open at once. Each holds a pooled
 * connection, so all of them together get a quarter of the pool, shared evenly
 * by the extensions on the runner, and never less than one each (owner decision,
 * 2026-10-10). Read at every `begin`: a load or unload moves the cap for the next
 * transaction, and ones already open are never cut short.
 */
export function hostTxnCap(poolMax: number, extensions: number): number {
  return Math.max(1, Math.floor(Math.floor(poolMax / 4) / Math.max(1, extensions)));
}

async function hostTxnStatement(
  managed: ManagedWorker,
  msg: Extract<WorkerToHostMessage, { type: 'db:query' }>,
  id: string,
  scope: InvokeScope | undefined,
  cap: number,
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
    if (managed.hostTxns.size >= cap) {
      throw new Error(
        `db.transaction() refused: "${managed.name}" already holds ${cap} open ` +
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
 * route or a service called during a request, whoever the caller (RFC step 8),
 * else in a transaction of its own — background work (`register()`, timers,
 * events, jobs) has no request whose answer could commit it, unless it opened
 * one (`hostTxnStatement`).
 */
async function runRawWithParams(
  extName: string,
  sql: string,
  params: unknown[],
  scope?: InvokeScope,
  at?: RunIn,
): Promise<unknown[]> {
  assertWorkerSqlAllowed(extName, sql, await workerSqlEngineTables());
  await assertNoWrittenByActionsWrite(extName, sql);
  const { encodeArrayParams } = await import('../db/bun-sql-dialect.js');
  const args = params.length > 0 ? encodeArrayParams(params) : undefined;
  const exec = (conn: Reserved) => conn.unsafe(sql, args) as Promise<unknown[]>;
  if (scope?.txn?.joined) {
    return inRequestTxn(
      scope.txn,
      extName,
      scope,
      (conn) => joinedStatement(conn, extName, scope, () => exec(conn)),
      at,
    );
  }
  if (scope?.txn) return inRequestTxn(scope.txn, extName, scope, exec, at);
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
