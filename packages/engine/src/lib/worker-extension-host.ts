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
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WORKER_RUNTIME_SOURCE } from './worker-extension-runtime-source.generated.js';
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
  RouteDescriptor,
  RouteInvokeResponse,
  InitResponse,
} from './worker-extension-protocol.js';
import { serviceRegistry } from './service-registry.js';

let _instance: WorkerExtensionHost | null = null;

/**
 * Lazy singleton — first call wires the host to the engine's main
 * Hono app. Subsequent calls return the same instance.
 */
export function getWorkerHost(app: Hono): WorkerExtensionHost {
  if (!_instance) _instance = new WorkerExtensionHost(app);
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

// Bun's `--compile` mode does NOT auto-bundle workers. Embed the pre-
// compiled worker JS as a string constant and write it to a temp file
// at first-spawn — Bun's Worker constructor accepts an absolute disk
// path. See packages/engine/scripts/gen-worker-source.ts.
let _workerRuntimePath: string | null = null;
function ensureWorkerRuntimeOnDisk(): string {
  if (_workerRuntimePath && existsSync(_workerRuntimePath)) return _workerRuntimePath;
  const dir = mkdtempSync(join(tmpdir(), 'zveltio-worker-'));
  const path = join(dir, 'worker-extension-runtime.mjs');
  writeFileSync(path, WORKER_RUNTIME_SOURCE, 'utf8');
  _workerRuntimePath = path;
  return path;
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

interface ManagedWorker {
  name: string;
  extDir: string;
  bundleEntry: string;
  worker: Worker;
  routes: RouteDescriptor[];
  pendingInvokes: Map<string, (res: RouteInvokeResponse) => void>;
  pendingInits: Map<string, (res: InitResponse) => void>;
  pendingPings: Map<string, () => void>;
  /** Service names this worker has registered. Used to unregister on
   *  respawn so stale entries don't shadow the new worker's exports. */
  registeredServices: Set<string>;
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

let nextRpcId = 0;
function rpcId(prefix: string): string {
  return `${prefix}-${++nextRpcId}`;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const MAX_RESPAWN_BACKOFF_MS = 30_000;

export class WorkerExtensionHost {
  private readonly workers = new Map<string, ManagedWorker>();
  private respawnBackoff = new Map<string, number>();

  constructor(private readonly app: Hono) {}

  /**
   * Spawn a worker for the extension at `extDir` and mount its routes
   * under `/ext/<name>/*` in the main Hono app. Returns when the worker
   * has reported its route table (i.e. `register()` ran successfully).
   */
  async start(extName: string, extDir: string, bundleEntry: string): Promise<void> {
    if (this.workers.has(extName)) {
      throw new Error(`Worker for "${extName}" is already running`);
    }
    const managed = await this.spawn(extName, extDir, bundleEntry, 1);
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
    managed.worker.terminate();
    this.workers.delete(extName);
    this.respawnBackoff.delete(extName);
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
  ): Promise<ManagedWorker> {
    const bundleUrl = pathToFileURL(join(extDir, bundleEntry)).href;
    const runtimePath = ensureWorkerRuntimeOnDisk();
    const worker = new Worker(pathToFileURL(runtimePath).href, { type: 'module' });
    const managed: ManagedWorker = {
      name: extName,
      extDir,
      bundleEntry,
      worker,
      routes: [],
      pendingInvokes: new Map(),
      pendingInits: new Map(),
      pendingPings: new Map(),
      registeredServices: new Set(),
      proxyUnmount: () => {},
      workerGeneration: generation,
      enabledAt: Date.now(),
      inFlightRequests: 0,
      totalRequests: 0,
      stopped: false,
    };

    worker.onmessage = (e) => this.handleWorkerMessage(managed, e.data as WorkerToHostMessage);
    worker.onerror = (e) => {
      console.error(`[worker:${extName}] error:`, (e as ErrorEvent).message);
      this.scheduleRespawn(managed, `onerror: ${(e as ErrorEvent).message}`);
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
        if (waiter) {
          invokeWaiters.delete(msg.id);
          waiter(msg);
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
      const rows = await runRawWithParams(msg.sql, msg.params);
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
   */
  private async handleServiceCall(
    managed: ManagedWorker,
    msg: Extract<WorkerToHostMessage, { type: 'service:call' }>,
  ): Promise<void> {
    try {
      // First check if a worker owns this service.
      const ownerWorker = this.findServiceOwner(msg.name);
      if (ownerWorker && ownerWorker.name !== managed.name) {
        const invokeId = rpcId('inv-svc');
        const reply = await new Promise<
          Extract<WorkerToHostMessage, { type: 'service:invoke:ok' | 'service:invoke:err' }>
        >((resolve, reject) => {
          invokeWaiters.set(invokeId, resolve);
          setTimeout(() => {
            if (invokeWaiters.has(invokeId)) {
              invokeWaiters.delete(invokeId);
              reject(new Error(`service "${msg.name}" call timeout (30s)`));
            }
          }, 30_000);
          this.post(ownerWorker, {
            type: 'service:invoke',
            id: invokeId,
            name: msg.name,
            args: msg.args,
          });
        });
        if (reply.type === 'service:invoke:err') {
          this.post(managed, {
            type: 'service:err',
            id: msg.id,
            error: reply.error ?? 'service call failed',
          });
        } else {
          this.post(managed, { type: 'service:ok', id: msg.id, result: reply.result });
        }
        return;
      }
      // Fall back to inline registry (host-side services).
      const impl = serviceRegistry.get<(...args: unknown[]) => unknown>(msg.name);
      if (!impl) {
        this.post(managed, {
          type: 'service:err',
          id: msg.id,
          error: `service "${msg.name}" not found`,
        });
        return;
      }
      const result = await Promise.resolve(impl(...msg.args));
      this.post(managed, { type: 'service:ok', id: msg.id, result });
    } catch (err) {
      this.post(managed, { type: 'service:err', id: msg.id, error: (err as Error).message });
    }
  }

  private handleServiceRegister(
    managed: ManagedWorker,
    msg: Extract<WorkerToHostMessage, { type: 'service:register' }>,
  ): void {
    try {
      // Publish a stub in the host registry that, when called, forwards
      // to the worker via service:invoke. This is what makes worker-
      // registered services callable from inline extensions / other
      // workers.
      serviceRegistry.scope(managed.name).register(msg.name, async (...args: unknown[]) => {
        const invokeId = rpcId('inv-svc');
        return await new Promise((resolve, reject) => {
          invokeWaiters.set(invokeId, (r) => {
            if (r.type === 'service:invoke:err') {
              reject(new Error(r.error ?? 'service call failed'));
            } else {
              resolve(r.result);
            }
          });
          setTimeout(() => {
            if (invokeWaiters.has(invokeId)) {
              invokeWaiters.delete(invokeId);
              reject(new Error(`service "${msg.name}" call timeout (30s)`));
            }
          }, 30_000);
          this.post(managed, {
            type: 'service:invoke',
            id: invokeId,
            name: msg.name,
            args,
          });
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
        async (c: { req: { raw: Request; query: () => Record<string, string> } }) => {
          const live = this.workers.get(managed.name);
          if (!live) return new Response('Extension worker is not running', { status: 503 });
          const bodyText = await c.req.raw.text().catch(() => '');
          const headers: Record<string, string> = {};
          c.req.raw.headers.forEach((v, k) => {
            headers[k] = v;
          });
          const id = rpcId('inv');
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
          }
        },
      );
    }
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
};

// Waiter pool for cross-worker service invokes. Module-scoped so any
// host method can stash a resolver under the rpcId and any worker's
// reply handler can route the response back.
const invokeWaiters = new Map<
  string,
  (msg: Extract<WorkerToHostMessage, { type: 'service:invoke:ok' | 'service:invoke:err' }>) => void
>();

/**
 * Execute `sql` with `params` against the engine's database, returning
 * the rows. Uses the Bun.SQL pool exposed by BunSqlDialect.
 */
async function runRawWithParams(sql: string, params: unknown[]): Promise<unknown[]> {
  const { getActiveBunPool } = await import('../db/bun-sql-dialect.js');
  const pool = getActiveBunPool();
  if (!pool) throw new Error('BunSQL pool not initialized — host cannot run worker queries');
  if (params.length > 0) {
    return (await pool.unsafe(sql, params)) as unknown[];
  }
  return (await pool.unsafe(sql)) as unknown[];
}
