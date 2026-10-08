/**
 * WorkerExtensionHost — spawns one Bun.Worker per isolated extension and
 * coordinates the RPC bridge described in worker-extension-protocol.ts.
 *
 * Lifecycle:
 *   1. `start(name, bundleUrl, ctx)` spawns the worker, sends `init`,
 *      receives the route table, mounts proxy routes under `/ext/<name>/*`.
 *   2. Inbound HTTP hits the proxy → IPC to worker → handler runs → IPC
 *      back → response written to client.
 *   3. Worker DB queries arrive as `db:query` → host executes via the
 *      real shared pool → posts `db:ok` / `db:err` back.
 *   4. `stop(name)` calls Worker.terminate() and removes proxy routes.
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
 *   - Worker is a THREAD (Bun.Worker), not a subprocess. V8 heap is
 *     isolated; OS RSS is shared with the engine. Crashes are isolated;
 *     per-extension RSS / OOM limits are not. See docs/EXTENSION-
 *     DEVELOPER-GUIDE.md §"Isolation tiers" for the threat model.
 */

import type { Hono } from 'hono';
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
import { serviceCallRefusal, serviceRegistry } from './service-registry.js';
import { getDb, type Database } from '../db/index.js';
import { activationMiddlewareFor, extensionLoader } from './extensions/index.js';
import { ProblemException, problem } from './problem.js';
import {
  assertWorkerSqlAllowed,
  workerDbRoleFor,
  workerSqlEngineTables,
} from './extensions/index.js';
import {
  getCurrentDomainOrNull,
  getRequestActor,
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

/** Per-extension health surface returned by getHealth(). No RSS field
 *  by design — Bun.Worker is a thread, so per-extension RSS isn't
 *  measurable. processRssMb at the host level is reported separately. */
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
}

interface ManagedWorker {
  name: string;
  extDir: string;
  bundleEntry: string;
  /** The in-thread `Worker`, or the runner process (worker-extension-transport.ts). */
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
  pendingInits: Map<string, (res: InitResponse) => void>;
  pendingPings: Map<string, () => void>;
  /** Service names this worker has registered. Used to unregister on
   *  respawn so stale entries don't shadow the new worker's exports. */
  registeredServices: Set<string>;
  /** Manifest `dependencies`: a call into one that is down answers 503. */
  dependencies: ReadonlySet<string>;
  /** `dependencies` + `optionalDependencies`: the owners whose services it may call. */
  mayCall: ReadonlySet<string>;
  /** Between a crash and the fresh spawn: in the map, but answering nothing. */
  respawning?: boolean;
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
function rpcId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const MAX_RESPAWN_BACKOFF_MS = 30_000;

export class WorkerExtensionHost {
  private readonly workers = new Map<string, ManagedWorker>();
  private respawnBackoff = new Map<string, number>();

  constructor(private app: Hono) {}

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
    optionalDependencies: readonly string[] = [],
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
      new Set([...dependencies, ...optionalDependencies]),
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
    failPendingInvokes(extName);
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
    mayCall: ReadonlySet<string>,
  ): Promise<ManagedWorker> {
    const bundleUrl = pathToFileURL(join(extDir, bundleEntry)).href;
    const runtimePath = ensureWorkerRuntimeOnDisk();
    // `env` is what keeps the engine's variables out of `process.env`,
    // `import('node:process')` and `Bun.env` (59 inherited variables before, 1
    // after). It does not keep them from the process: this is a thread, and it can
    // read what the process can read. Hence the production opt-in
    // (`enforceWorkerOptIn`) until extensions run out of process.
    const env = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
    const transport = extensionTransport();
    const worker: ExtensionChannel =
      transport === 'runner'
        ? connectRunner(await startRunner(extName))
        : transport === 'process'
          ? spawnProcessRunner(runtimePath, env)
          : new Worker(pathToFileURL(runtimePath).href, { type: 'module', env } as WorkerOptions);
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
      proxyUnmount: () => {},
      workerGeneration: generation,
      enabledAt: Date.now(),
      inFlightRequests: 0,
      totalRequests: 0,
      stopped: false,
    };

    worker.onmessage = (e) => this.handleWorkerMessage(managed, e.data);
    worker.onerror = (e) => {
      console.error(`[worker:${extName}] error:`, e.message);
      this.scheduleRespawn(managed, `onerror: ${e.message}`);
    };

    const initId = rpcId('init');
    const init = await new Promise<InitResponse>((resolve, reject) => {
      managed.pendingInits.set(initId, resolve);
      setTimeout(() => {
        if (managed.pendingInits.has(initId)) {
          managed.pendingInits.delete(initId);
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
      });
    });

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
    // A caller waiting on the dead worker would otherwise sit out the 30s timeout.
    failPendingInvokes(managed.name);
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
      const scope = requestScope(managed, msg.requestId, 'query');
      const rows = await runRawWithParams(managed.name, msg.sql, msg.params, scope);
      this.post(managed, { type: 'db:ok', id: msg.id, rows });
    } catch (err) {
      this.post(managed, { type: 'db:err', id: msg.id, error: (err as Error).message });
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
      const owner = ownerWorker?.name ?? serviceRegistry.ownerOf(name);
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
        this.post(target, { type: 'service:invoke', id: invokeId, name, args });
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
          const headers: Record<string, string> = {};
          c.req.raw.headers.forEach((v, k) => {
            headers[k] = v;
          });
          const id = rpcId('inv');
          const reqTenantId = (c.get('tenant') as { id?: string } | null)?.id ?? null;
          live.invokeTenants.set(id, currentScope(reqTenantId));
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
                path: new URL(c.req.raw.url).pathname.replace(`/ext/${live.name}`, '') || '/',
                headers,
                query: c.req.query(),
                body: bodyText || undefined,
                tenantId: reqTenantId ?? undefined,
              });
            });
            if (resp.type === 'route:err') {
              return new Response(resp.error ?? 'worker error', { status: 500 });
            }
            return new Response(resp.body ?? '', {
              status: resp.status ?? 200,
              headers: resp.headers,
            });
          } catch (err) {
            return new Response((err as Error).message, { status: 500 });
          } finally {
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
  return tenantId ? { tenantId, actor: getRequestActor() } : { tenantId };
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

/** Settle every call waiting on `extName`'s worker: it will not answer. */
function failPendingInvokes(extName: string): void {
  for (const [id, waiter] of invokeWaiters) {
    if (waiter.expect !== extName) continue;
    invokeWaiters.delete(id);
    waiter.reject(dependencyDown(extName));
  }
}

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

async function runRawWithParams(
  extName: string,
  sql: string,
  params: unknown[],
  scope?: InvokeScope,
): Promise<unknown[]> {
  const tenantId = scope?.tenantId;
  assertWorkerSqlAllowed(extName, sql, await workerSqlEngineTables());

  const { getActiveBunPool } = await import('../db/bun-sql-dialect.js');
  const pool = getActiveBunPool();
  if (!pool) throw new Error('BunSQL pool not initialized — host cannot run worker queries');

  const reserved = await pool.reserve();
  let inTransaction = false;
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
    inTransaction = true;
    await reserved.unsafe(`SET LOCAL statement_timeout = '${WORKER_QUERY_TIMEOUT_S}s'`);
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
    const role = await pickWorkerSqlRole(reserved, workerDbRoleFor(extName));
    if (!role) throw noWorkerSqlRole(extName);
    await reserved.unsafe(`SET LOCAL ROLE ${role}`);
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
                set_config('zveltio.system_collections', '', true)`,
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
        ],
      );
    }
    const rows = (await reserved.unsafe(sql, params.length > 0 ? params : undefined)) as unknown[];
    await reserved.unsafe('COMMIT');
    inTransaction = false;
    return rows;
  } finally {
    // Reset before returning the connection to the pool — these are per-SESSION
    // settings, not per-transaction, so leaking either would silently cap or
    // de-privilege unrelated engine queries that reuse this connection.
    // Order matters: RESET ROLE last, because resetting the tenant GUC needs
    // the privileges the role may not have.
    // ROLLBACK is what returns the connection clean when the statement threw. If
    // even that fails the connection is in an unknown state, and the one thing it
    // must not be is reused: a borrower inheriting a role or a tenant id is the
    // failure this block exists to prevent. Losing a connection is cheaper than
    // handing out a contaminated one.
    if (inTransaction) {
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
  }
}
