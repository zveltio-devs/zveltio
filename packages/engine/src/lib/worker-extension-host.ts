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
 *   3. A worker is declared model only (ADR 0056, amendment 2026-11-21; RFC v3
 *      phase D slice 4): it serves its declared routes and actions, and reaches
 *      data through their `host` (`host:call`). Nothing else crosses.
 *   4. `stop(name)` ends the process and removes proxy routes.
 *
 * Reliability (alpha.122):
 *   - Crash auto-recovery: worker.onerror / unexpected exit → respawn
 *     with exponential backoff. workerGeneration is incremented per
 *     respawn so operators can detect flapping.
 *   - Hang detection: heartbeat ping every 30s, terminate + respawn
 *     after 60s with no pong. Prevents a stuck extension from holding
 *     proxy routes open forever.
 *   - The box fails alone (ADR 0056): a call that outlives the request's
 *     hard timeout has its request's statement cancelled (504); requests
 *     past `boxConcurrencyLimit` are refused (503); `CRASH_LIMIT` crashes
 *     in `CRASH_WINDOW_MS` disable it; every line names it and its key.
 *
 * Security envelope:
 *   - Worker never receives DATABASE_URL or any other env credential.
 *   - The extension is a process. On the runner it runs under a uid of
 *     its own with kernel limits (RFC extension-runner); as a local child
 *     (`process`, development) under the engine's uid, with no boundary.
 */

import { nodeEnv } from './operational-modes.js';
import type { Context, Hono } from 'hono';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { join, posix } from 'node:path';
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
  FrameTooLargeError,
} from './worker-extension-transport.js';
import { activePoolMax, getDb, type Database } from '../db/index.js';
import { auditLog } from './audit.js';
import { verifyExtensionDir } from './security/index.js';
import { CompiledQuery } from 'kysely';
import { transactionTurns } from '../db/trx-sequencer.js';
import {
  CREDENTIAL_HEADERS,
  actionHostCall,
  activationMiddlewareFor,
  crossedRefusal,
  refusalProblem,
  verifyRegistrySignedDir,
} from './extensions/index.js';
import type { ActionHost } from '@zveltio/sdk/extension';
import { compilePattern, extensionRequestRefused } from '../middleware/extension-auth-gate.js';
import { ProblemException, problem, problemOnError } from './problem.js';
import {
  beforeRequestTransactionEnds,
  getCurrentDomainOrNull,
  getCurrentTenantTrx,
  getCurrentTrxTenant,
  requestTransactionState,
  getRequestActor,
  getResolvedMembership,
  type RequestActor,
  runOutsideTenantContext,
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
  /**
   * `crashed`: between a crash and its respawn. `disabled`: it crashed
   * `CRASH_LIMIT` times in `CRASH_WINDOW_MS` and is not respawned (ADR 0056);
   * `disabledReason` says why.
   */
  status: 'running' | 'crashed' | 'starting' | 'disabled';
  disabledReason?: string;
  /** Crashes (exits, hangs, failed respawns) in the last `CRASH_WINDOW_MS`. */
  recentCrashes: number;
  /** Requests it may serve at once; one more is refused (ADR 0056). */
  concurrencyLimit: number;
  /** The key its signature verified against; null until signatures carry the tier (ADR 0056 s3). */
  keyId: string | null;
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
  /** The request's async context — domain, tenant, the API key the gate admitted. */
  run?: <R>(fn: () => R) => R;
  /**
   * The route request this is, of which extension: what `host.collections`
   * answers for (ADR 0025).
   */
  route?: { extName: string; c: unknown };
  /** The request's database transaction: its own tenant transaction, joined. */
  txn?: RequestTxn;
  /** Where in `txn` this invocation's statements take their turn: its caller's place. */
  within?: RunIn;
  /**
   * An action run (ADR 0056): the `ActionHost` the engine built for it, which
   * answers its `host` calls, and the refusals it answered them with, by call
   * id, so one the action lets through is rethrown as it was raised.
   */
  action?: { host: ActionHost; refusals: Map<string, ProblemException> };
}

type RunIn = <R>(fn: () => R) => R;

/**
 * What the engine hands the host for one worker-isolated extension: its
 * declared model, the answers to its `host` calls (from the same inline code
 * an inline extension's are), and who signed it.
 */
export interface WorkerCtxSource {
  /**
   * Public route pattern → credential headers the worker receives: the manifest's
   * `forwardCredentials` only once an operator approved all of it (register.ts),
   * never the manifest's own claim.
   */
  forwardCredentials?: Record<string, readonly string[]>;
  /** The manifest's own `forwardCredentials`, against which an approval change is re-resolved. */
  declaredForwardCredentials?: Record<string, string[]>;
  /** One `host.collections` call of a route serving `c`, its arguments checked (ADR 0025). */
  collections?: (c: unknown, call: string, args: unknown[]) => Promise<unknown>;
  /** The manifest's `routes` (ADR 0039): the worker pairs them with its handlers and serves them. */
  declaredRoutes?: { method: string; path: string; handler: string }[];
  /** The manifest's actions by name (ADR 0056): the worker pairs them with its implementations. */
  actions?: string[];
  /**
   * Mount the engine's action route on the worker's sub-app, after its
   * activation check and ahead of every route the worker registered, as inline.
   */
  mountActions?: (sub: Hono) => void;
  /**
   * The id of the operator key its directory signature verified against, named
   * in every log line about it (ADR 0056). `key=absent` for an unsigned one.
   */
  keyId?: string;
  /**
   * The id of the registry key the archive kept with its files verified against
   * (level 2), named in its log lines when no operator key is.
   */
  registryKeyId?: string;
}

/**
 * The request headers a worker is handed: all of them but the caller's
 * credentials (`CREDENTIAL_HEADERS`), save those in `forward`.
 *
 * The worker is the extension the platform chose not to trust. Handed the
 * caller's cookie or API key, it could replay them and act as the caller on
 * every route of the instance. It needs neither: its `host` calls are answered
 * as the caller, and signature headers (`stripe-signature`, …) still pass.
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
   * Tenant and caller of each in-flight `route:invoke` and `action:invoke`,
   * keyed by the id the host minted.
   *
   * This is the host's own record of what it dispatched. A `host:call` names an
   * invocation and is answered as the record here — never as the message says,
   * since the worker is the untrusted party and a tenant or user it asserts is
   * one it picked.
   */
  invokeTenants: Map<string, InvokeScope>;
  pendingInits: Map<string, (res: InitResponse) => void>;
  pendingPings: Map<string, () => void>;
  /** Between a crash and the fresh spawn: in the map, but answering nothing. */
  respawning?: boolean;
  /**
   * Why it was disabled after `CRASH_LIMIT` crashes (ADR 0056): retired, never
   * respawned, kept in the map so its routes answer this and a rebuild of the
   * app does not start it again. An operator's disable and enable, or a
   * restart, starts it afresh.
   */
  disabled?: string;
  /**
   * The requests in it now, each with the number of its calls in flight: a
   * request's nested calls (an action calling one of its own) take one place
   * of the concurrency limit, as they hold one connection.
   */
  active?: Map<object, number>;
  /** When a refusal past the limit was last logged. */
  busyLoggedAt?: number;
  source?: WorkerCtxSource;
  /** A frame outside the protocol was refused and logged for this process. */
  refusalLogged?: boolean;
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
    NODE_ENV: nodeEnv() ?? 'production',
  });
}

function rpcId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const MAX_RESPAWN_BACKOFF_MS = 30_000;

/**
 * ADR 0056: this many crashes — an exit, a missed heartbeat, a respawn that
 * failed — within `CRASH_WINDOW_MS` and the extension is disabled, not
 * respawned. Five in ten minutes is a crash loop (the backoff alone fits five in
 * about half a minute); one crash an hour never adds up to it.
 */
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 10 * 60_000;

/**
 * Requests one worker-isolated extension may serve at once (ADR 0056): a quarter
 * of the pool, and never less than one. Each holds a
 * pooled connection — its request's — for as long as the extension takes, so
 * past this a slow or hostile extension would starve the engine's own requests.
 */
export function boxConcurrencyLimit(poolMax: number): number {
  return Math.max(1, Math.floor(poolMax / 4));
}

/** How every log line about an extension names it: its name and its signing key (ADR 0056). */
function boxTag(name: string, source?: WorkerCtxSource): string {
  return `[ext:${name} key=${source?.keyId ?? source?.registryKeyId ?? 'absent'}]`;
}

/**
 * Its trust level when signed: 3 for an operator key, 2 for the registry's. Both
 * are declared model only (ADR 0056 d1, amendment 2026-11-21); null only for an
 * unsigned bundle, which runs under the test override alone.
 */
function signedLevel(source?: WorkerCtxSource): 2 | 3 | null {
  if (source?.keyId !== undefined) return 3;
  return source?.registryKeyId !== undefined ? 2 : null;
}

/**
 * ADR 0056 d1 and amendment 2026-11-16 point 4: a signed extension's signature
 * — an operator's, or the registry's kept with its files — is verified again at
 * every spawn (first start, crash respawn, restart) before its bundle is
 * imported, and the bundle's signed sha256 goes to the worker, which imports
 * only bytes that hash to it. Undefined for an unsigned one.
 */
async function signedBundleSha256(
  extName: string,
  extDir: string,
  bundleEntry: string,
  source: WorkerCtxSource,
): Promise<string | undefined> {
  const level = signedLevel(source);
  if (level === null) return undefined;
  const loadedKey = level === 3 ? source.keyId : source.registryKeyId;
  const signed =
    level === 3
      ? await verifyExtensionDir(extName, extDir)
      : await verifyRegistrySignedDir(extName, extDir);
  if (!signed || signed.keyId !== loadedKey) {
    throw new Error(
      `"${extName}" was loaded signed by ${level === 3 ? 'operator' : 'registry'} key ` +
        `"${loadedKey}" and now ` +
        `${signed ? `carries key "${signed.keyId}"` : 'carries no signature'}; load it again`,
    );
  }
  const sha = signed.files.get(posix.normalize(bundleEntry));
  if (!sha) {
    throw new Error(`"${extName}": its bundle ${bundleEntry} is not a file its signature covers`);
  }
  return sha;
}

export class WorkerExtensionHost {
  private readonly workers = new Map<string, ManagedWorker>();
  private respawnBackoff = new Map<string, number>();
  /** Each extension's recent crash times, for `CRASH_LIMIT`; a stop forgets them. */
  private crashTimes = new Map<string, number[]>();

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
    source: WorkerCtxSource = {},
  ): Promise<void> {
    if (this.workers.has(extName)) {
      throw new Error(`Worker for "${extName}" is already running`);
    }
    const managed = await this.spawn(extName, extDir, bundleEntry, 1, source);
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
    failPendingInvokes(extName);
    failPendingRoutes(managed);
    managed.worker.terminate();
    this.workers.delete(extName);
    this.respawnBackoff.delete(extName);
    this.crashTimes.delete(extName);
    // Disable stops the extension's runner unit, not only its runtime.
    if (extensionTransport() === 'runner') {
      await stopRunner(extName).catch((err) =>
        console.error(
          `${boxTag(extName, managed.source)} stopping its runner: ${(err as Error).message}`,
        ),
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
      // A disabled one stays down: its enable reads the approval afresh.
      const managed = this.workers.get(extName);
      if (!managed || managed.disabled) return;
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
    // A disabled one is kept, not restarted: its routes answer why.
    if (!managed || (managed.respawning && !managed.disabled)) return false;
    managed.proxyUnmount = this.mountProxyRoutes(managed);
    return true;
  }

  /** Per-extension health snapshot — used by /api/admin/extensions/health. */
  getHealth(): WorkerHealth[] {
    const now = Date.now();
    const limit = boxConcurrencyLimit(activePoolMax());
    return [...this.workers.values()].map((m) => ({
      name: m.name,
      isolation: 'worker' as const,
      status: m.disabled
        ? ('disabled' as const)
        : m.stopped || m.respawning
          ? ('crashed' as const)
          : ('running' as const),
      disabledReason: m.disabled,
      recentCrashes: (this.crashTimes.get(m.name) ?? []).filter((t) => now - t < CRASH_WINDOW_MS)
        .length,
      concurrencyLimit: limit,
      keyId: m.source?.keyId ?? null,
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
    source: WorkerCtxSource,
  ): Promise<ManagedWorker> {
    const bundleUrl = pathToFileURL(join(extDir, bundleEntry)).href;
    const bundleSha256 = await signedBundleSha256(extName, extDir, bundleEntry, source);
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
      source,
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
    // names (`requestScope`) or as no one, never in the context the worker was
    // spawned or respawned in (an enable request's).
    worker.onmessage = (e) =>
      runOutsideTenantContext(() => this.handleWorkerMessage(managed, e.data));
    worker.onerror = (e) => {
      console.error(`${boxTag(extName, source)} error:`, e.message);
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
        ...(bundleSha256 ? { bundleSha256 } : {}),
        extName,
        env: {
          NODE_ENV: nodeEnv() ?? 'production',
          extensionPath: extDir,
        },
        routes: source.declaredRoutes ?? [],
        actions: source.actions ?? [],
      });
    });
    failInit = null;

    if (init.type === 'init:err') {
      worker.terminate();
      managed.loadError = init.error;
      throw new Error(`worker "${extName}" init failed: ${init.error}`);
    }
    // Its declared routes, the only ones a worker serves.
    managed.routes = (source.declaredRoutes ?? []).map(({ method, path }) => ({ method, path }));
    return managed;
  }

  /**
   * Crash recovery: terminate the current worker, exponential-backoff
   * a fresh spawn, transfer the proxy routes to the new worker. The
   * Hono sub-app stays mounted; it just gets a new ManagedWorker
   * underneath.
   */
  private scheduleRespawn(managed: ManagedWorker, reason: string): void {
    if (managed.stopped || managed.disabled) return;
    if (this.workers.get(managed.name) !== managed) return;
    const now = Date.now();
    managed.lastCrashAt = now;
    this.retire(managed);
    const crashes = [
      ...(this.crashTimes.get(managed.name) ?? []).filter((t) => now - t < CRASH_WINDOW_MS),
      now,
    ];
    this.crashTimes.set(managed.name, crashes);
    const tag = boxTag(managed.name, managed.source);
    if (crashes.length >= CRASH_LIMIT) {
      // Not respawned: a crash loop takes a connection, a runner process and the
      // logs with it on every turn. Its routes and actions answer this until an
      // operator disables and enables it again (or the engine restarts).
      managed.disabled =
        `disabled after ${crashes.length} crashes in ${CRASH_WINDOW_MS / 60_000} minutes ` +
        `(last: ${reason}); disable and enable it again once it is fixed`;
      console.error(`${tag} crash: ${reason} — ${managed.disabled}`);
      // Kept, unlike the in-memory disable (amendment 2026-11-16 §1).
      try {
        const db = getDb();
        void runOutsideTenantContext(() =>
          auditLog(db, {
            type: 'extension.crash_disabled',
            tenantId: null,
            resourceId: managed.name,
            resourceType: 'extension',
            metadata: {
              reason: managed.disabled,
              keyId: managed.source?.keyId ?? null,
              actor: 'system',
            },
          }),
        ).catch((err: Error) => console.error(`${tag} audit: ${err.message}`));
      } catch {
        /* no database (unit tests): nothing to record in */
      }
      if (extensionTransport() === 'runner') {
        void stopRunner(managed.name).catch((err) =>
          console.error(`${tag} stopping its runner: ${(err as Error).message}`),
        );
      }
      return;
    }
    const prevBackoff = this.respawnBackoff.get(managed.name) ?? 500;
    const backoff = Math.min(prevBackoff * 2, MAX_RESPAWN_BACKOFF_MS);
    this.respawnBackoff.set(managed.name, backoff);
    console.warn(
      `${tag} crash ${crashes.length}/${CRASH_LIMIT}: ${reason} — respawning in ${backoff}ms`,
    );
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
        console.error(`${tag} respawn failed: ${(err as Error).message}`);
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
        this.scheduleRespawn(
          managed,
          `hang: no answer to its heartbeat within ${HEARTBEAT_TIMEOUT_MS}ms`,
        );
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
      case 'host:call':
        void this.handleHostCall(managed, msg);
        break;
      case 'action:ok':
      case 'action:err': {
        // The answer of an action this host asked the worker to run.
        const waiter = invokeWaiters.get(msg.id);
        // Only the worker that was asked may answer. Without this any worker
        // could resolve another extension's pending action with forged data.
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
        console[msg.level](`${boxTag(managed.name, managed.source)} ${msg.message}`);
        break;
      default:
        // Outside the protocol (ADR 0056, amendment 2026-11-21; RFC v3 phase D
        // slice 4): no SQL, service or event frame crosses from any worker,
        // signed or not. Logged once per process: a bundle posting in a loop
        // must not flood the log.
        if (!managed.refusalLogged) {
          managed.refusalLogged = true;
          console.error(
            `${boxTag(managed.name, managed.source)} refused a "${String((msg as { type?: unknown }).type)}" ` +
              'frame: a worker-isolated extension is declared model only — collections, actions, ' +
              'jobs, declared routes (ADR 0056); further refusals not logged',
          );
        }
    }
  }

  /**
   * A declared route's or action's `host` call, answered as the invocation the
   * call names — from the host's own record of it, never from the worker.
   * Anything else is refused, from every worker.
   */
  private async handleHostCall(
    managed: ManagedWorker,
    msg: Extract<WorkerToHostMessage, { type: 'host:call' }>,
  ): Promise<void> {
    let scope: InvokeScope | undefined;
    try {
      scope = requestScope(managed, msg.requestId, msg.op);
      // In a joined request transaction, at the caller's place in its turns.
      const run = (scope?.txn?.joined && scope.within) || scope?.run || (<R>(fn: () => R) => fn());
      const [a] = msg.args;
      let result: unknown;
      switch (msg.op) {
        case 'collections': {
          const route = scope?.route;
          const answer = managed.source?.collections;
          if (!answer || route?.extName !== managed.name) {
            throw new Error('host.collections answers only in a route request of this extension');
          }
          if (!/^collections\.(read|list|insert|update|delete)$/.test(String(a))) {
            throw new Error(`unknown host.collections call "${String(a)}"`);
          }
          result = await run(() => answer(route.c, String(a), msg.args.slice(1)));
          break;
        }
        case 'action': {
          const host = scope?.action?.host;
          if (!host) throw new Error('an action host answers only in a run of one of its actions');
          result = await run(() => actionHostCall(host, String(a), msg.args.slice(1)));
          break;
        }
        default:
          throw new Error(
            `host call "${String(msg.op)}" is refused: a worker-isolated extension is declared ` +
              'model only — its routes reach host.collections, its actions their host (ADR 0056)',
          );
      }
      this.post(managed, { type: 'host:ok', id: msg.id, result });
    } catch (err) {
      if (err instanceof ProblemException) scope?.action?.refusals.set(msg.id, err);
      this.post(managed, {
        type: 'host:err',
        id: msg.id,
        error: (err as Error).message,
        ...(err instanceof ProblemException ? { status: err.status } : {}),
      });
    }
  }

  /**
   * Run `extName`'s action `name` in its worker (ADR 0056), as the request this
   * is called in: its tenant, caller and transaction. `mountActions` made every
   * check before this, and `host` is the one it built: the worker's `host` calls
   * are answered by it.
   */
  async runAction(extName: string, name: string, input: unknown, host: ActionHost) {
    const managed = this.workers.get(extName);
    if (!managed || managed.respawning) throw boxDown(extName, managed?.disabled);
    const scope = callerScope();
    try {
      return await this.invokeAction(managed, name, [input, host.timezone], {
        ...scope,
        ...(await joinRequestTxn(scope)),
        action: { host, refusals: new Map() },
      });
    } catch (err) {
      // A refusal is the action's answer, and the box's own (busy, timed out,
      // crashed) was logged where it arose; anything else is its failure, named.
      const refused =
        err instanceof ProblemException ? err : (refusalProblem(err) as ProblemException | null);
      if (!refused || (refused.status >= 500 && !refused.code.startsWith('extension.'))) {
        console.error(
          `${boxTag(extName, managed.source)} action "${name}" failed: ${(err as Error)?.message}`,
        );
      }
      throw err;
    }
  }

  /**
   * Ask `target` to run its action `name` on behalf of a caller in `scope`, and
   * return its result.
   *
   * The invoke id is recorded in the target's `invokeTenants` for as long as the
   * call is pending, so the `host` calls the action makes under it are answered
   * as the caller — the same record, and the same lifetime, as a route
   * invocation's.
   */
  private async invokeAction(
    target: ManagedWorker,
    name: string,
    args: unknown[],
    scope: InvokeScope,
  ): Promise<unknown> {
    const invokeId = rpcId('inv-act');
    // In a request, a call into the box: counted, and refused past its limit.
    const leave = scope.txn ? this.admit(target, scope.txn) : () => {};
    target.invokeTenants.set(invokeId, scope);
    try {
      const reply = await new Promise<
        Extract<WorkerToHostMessage, { type: 'action:ok' | 'action:err' }>
      >((resolve, reject) => {
        invokeWaiters.set(invokeId, { expect: target.name, action: name, resolve, reject });
        setTimeout(
          () => {
            if (!invokeWaiters.has(invokeId)) return;
            invokeWaiters.delete(invokeId);
            // Its work is over: nothing more it sends runs as this request.
            target.invokeTenants.delete(invokeId);
            const err = this.timedOut(target, `action "${name}"`);
            // Its statement cancelled first, while the request still holds the
            // connection: the caller's answer is what ends the request.
            if (scope.txn?.joined) void cancelJoinedStatement(scope.txn).finally(() => reject(err));
            else reject(err);
            // In a request, the request's hard timeout, as a worker route's.
            // Outside one, the fixed ceiling.
          },
          scope.txn ? requestTxnTimeoutMs : REQUEST_TXN_TIMEOUT_MS,
        );
        this.post(target, { type: 'action:invoke', id: invokeId, name, args });
      });
      if (reply.type === 'action:err') {
        // An action's refusal as it was raised: the engine's own, or one it threw.
        const raised = reply.hostError && scope.action?.refusals.get(reply.hostError);
        if (raised) throw raised;
        if (reply.refusal) throw crossedRefusal(reply.refusal);
        const err = new Error(reply.error ?? 'action failed');
        throw reply.errno ? Object.assign(err, { errno: reply.errno }) : err;
      }
      return reply.result;
    } finally {
      leave();
      target.invokeTenants.delete(invokeId);
    }
  }

  /**
   * Admit a call into `managed` for the request `key` (its transaction): a
   * request already in it passes, a new one past `boxConcurrencyLimit` is
   * refused before the worker sees it, holding nothing (ADR 0056). Returns the
   * call's release.
   */
  private admit(managed: ManagedWorker, key: object): () => void {
    managed.active ??= new Map();
    const active = managed.active;
    const held = active.get(key);
    const limit = boxConcurrencyLimit(activePoolMax());
    if (held === undefined && active.size >= limit) {
      // Once in ten seconds: a flood of refusals is not a flood of lines.
      if (Date.now() - (managed.busyLoggedAt ?? 0) > 10_000) {
        managed.busyLoggedAt = Date.now();
        console.warn(
          `${boxTag(managed.name, managed.source)} busy: ${limit} requests in it, its limit; more are refused`,
        );
      }
      const busy = problem(
        'extension.busy',
        503,
        `extension "${managed.name}" is serving ${limit} requests, as many as it may at once; retry shortly`,
      );
      busy.retryAfter = 1;
      throw busy;
    }
    active.set(key, (held ?? 0) + 1);
    managed.inFlightRequests = active.size;
    managed.totalRequests++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const n = (active.get(key) ?? 1) - 1;
      if (n > 0) active.set(key, n);
      else active.delete(key);
      managed.inFlightRequests = active.size;
    };
  }

  /** A call into `managed` that outlived the request's hard timeout: logged, and its 504. */
  private timedOut(managed: ManagedWorker, what: string): ProblemException {
    const ms = requestTxnTimeoutMs;
    console.error(
      `${boxTag(managed.name, managed.source)} timeout: ${what} did not answer within ${ms}ms`,
    );
    return problem(
      'extension.timeout',
      504,
      `extension "${managed.name}": ${what} call timeout, no answer within ${ms} ms`,
    );
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
    //
    // Before the routes: Hono runs handlers in registration order and a route
    // answers without calling `next`, so a gate registered after them never ran.
    sub.use('*', async (c, next) => {
      let db: Database;
      try {
        db = getDb();
      } catch {
        return next();
      }
      return activationMiddlewareFor(managed.name, db)(c, next);
    });
    managed.source?.mountActions?.(sub);
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
          if (!live || live.respawning) {
            return problemOnError(boxDown(managed.name, live?.disabled), c as unknown as Context);
          }
          // Bytes, not text: a text decode replaced every invalid UTF-8 sequence,
          // so an image or PDF upload reached the handler corrupted.
          const body = await c.req.raw
            .arrayBuffer()
            .then((b) => new Uint8Array(b))
            .catch(() => undefined);
          // Drop the `/ext/<name>` segments rather than string-replacing the
          // name: Hono matched a percent-encoded name (`/ext/%70robe/x`), and
          // a replace left the whole path for the worker to 404 on. As many as
          // the name has: a fixed three left `/b` of `a/b` in the path, so the
          // worker served another route than the one the gate decided on.
          const subPath = `/${new URL(c.req.raw.url).pathname
            .split('/')
            .slice(2 + managed.name.split('/').length)
            .join('/')}`;
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
          const scope: InvokeScope = {
            ...currentScope(reqTenantId),
            run: AsyncLocalStorage.snapshot(),
            route: { extName: managed.name, c },
          };
          // The request's own tenant transaction, joined: what the route's
          // `host.collections` calls write is kept or undone with the request.
          // A request with no tenant transaction still opens its own record.
          const joined = await joinRequestTxn(scope);
          const txn = joined.txn ?? newRequestTxn();
          let leave: () => void;
          try {
            leave = this.admit(live, txn);
          } catch (err) {
            await endRequestTxn(txn, false);
            return problemOnError(err as Error, c as unknown as Context);
          }
          live.invokeTenants.set(id, { ...scope, ...joined, txn });
          try {
            const resp = await new Promise<RouteInvokeResponse>((resolve, reject) => {
              live.pendingInvokes.set(id, resolve);
              const timer = setTimeout(() => {
                if (!live.pendingInvokes.has(id)) return;
                live.pendingInvokes.delete(id);
                live.invokeTenants.delete(id);
                const err = this.timedOut(live, `route ${r.method} ${r.path}`);
                // As an action's (`invokeWorkerService`): its statement first.
                if (txn.joined) void cancelJoinedStatement(txn).finally(() => reject(err));
                else reject(err);
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
                  url: c.req.raw.url,
                  headers,
                  query: c.req.query(),
                  body: body?.length ? body : undefined,
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
              console.error(
                `${boxTag(live.name, live.source)} route ${r.method} ${r.path} failed: ${resp.error}`,
              );
              // An uncaught SQLSTATE answers as an inline route's (22P02 → 400, 55P03 → 503).
              if (resp.errno) {
                const err = Object.assign(new Error(resp.error), { errno: resp.errno });
                return problemOnError(err, c as unknown as Context);
              }
              return new Response(resp.error ?? 'worker error', { status: 500 });
            }
            return new Response(resp.body ?? null, {
              status: resp.status ?? 200,
              headers: resp.headers,
            });
          } catch (err) {
            // The caller's body is too big to hand over: theirs to fix, not a 500.
            if (err instanceof FrameTooLargeError) {
              return Response.json({ error: 'Request body too large' }, { status: 413 });
            }
            if (err instanceof ProblemException) {
              return problemOnError(err, c as unknown as Context);
            }
            return new Response((err as Error).message, { status: 500 });
          } finally {
            // Timed out, or the worker died: nothing it wrote is kept. What the
            // request's tenant transaction holds for it is rolled back, as for an
            // inline route that threw: `tenantMiddleware` does on `c.error`, and
            // keeps this answer.
            if (!(await endRequestTxn(txn, false))) {
              c.error ??= new Error('the worker request was rolled back');
            }
            leave();
            // The request is over, so the id can no longer name a tenant. Left
            // behind, this map grows for the lifetime of the process and a
            // worker could keep quoting a finished request's id to hold on to
            // its tenant context.
            live.invokeTenants.delete(id);
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
  newRequestTxn,
  failPendingRoutes,
  /** The request transaction's hard timeout; no argument restores the default. */
  setRequestTxnTimeoutMs(ms = REQUEST_TXN_TIMEOUT_MS): void {
    requestTxnTimeoutMs = ms;
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
  // The reach the request's own transaction resolved: NO_UNITS exactly when
  // it published NO_UNITS there (rows, none in force). A user with no row
  // published no set — the default tenant's single-tenant case — and reads
  // the tenant inline, so here too.
  const userId = actor?.userId;
  const noUnits = !!userId && getResolvedMembership(userId, tenantId) === 'lapsed';
  return { tenantId, actor, noUnits };
}

/**
 * `currentScope` plus the caller's async context, for an action run from the
 * caller's own context: read from the engine's record of the request
 * transaction, never from the caller.
 */
function callerScope(): InvokeScope {
  return { ...currentScope(getCurrentDomainOrNull()), run: AsyncLocalStorage.snapshot() };
}

/**
 * The tenant and caller of the invocation a worker message names, from the
 * host's own record — `undefined` when it names none (background work), and a
 * refusal when it names one the record no longer holds.
 *
 * Refused, not demoted to no tenant: such a message is work a request started
 * and did not wait for (a timer, an un-awaited promise, a handler past the 30 s
 * timeout), still carrying the request's async context after the request ended.
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

// Waiter pool for action runs, by invoke id.
//
// Module-scoped, and every worker's reply handler reads it: `expect` pins the
// worker that was actually asked, so a worker cannot answer an action run sent
// to a DIFFERENT extension with whatever it likes. A reply from anyone else is
// dropped.
const invokeWaiters = new Map<
  string,
  {
    expect: string;
    resolve: (msg: Extract<WorkerToHostMessage, { type: 'action:ok' | 'action:err' }>) => void;
    reject: (err: Error) => void;
    action: string;
  }
>();

/** Settle every call waiting on `extName`'s worker: it will not answer. */
function failPendingInvokes(extName: string): void {
  for (const [id, waiter] of invokeWaiters) {
    if (waiter.expect !== extName) continue;
    invokeWaiters.delete(id);
    waiter.reject(
      problem(
        'extension.unavailable',
        503,
        `extension "${extName}" stopped while running action "${waiter.action}"; nothing it wrote was kept`,
      ),
    );
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
}

const NOT_COMMITTED = 'The request could not be committed; nothing it wrote was kept.';

/**
 * A call into an extension that is not answering (ADR 0056): restarting after a
 * crash (retry shortly), disabled after too many (`disabled`, the reason), or
 * not running. Its own code, not a dependency's: the caller called it.
 */
function boxDown(extName: string, disabled?: string): ProblemException {
  if (disabled) return problem('extension.disabled', 503, `extension "${extName}" is ${disabled}`);
  const down = problem(
    'extension.unavailable',
    503,
    `extension "${extName}" is not running (restarting after a crash, or stopped); retry shortly`,
  );
  down.retryAfter = 1;
  return down;
}

/**
 * Cancel the statement running now on a joined request transaction's
 * connection (ADR 0056): a call into the box that timed out ends its request's
 * work in the database at once — the transaction is then aborted, rolled back
 * by its request, and every lock it held is released — not when the statement
 * or the lock it waits for lets go (an engine statement has no
 * `statement_timeout`). Only while that backend is still in this transaction,
 * which its start time identifies: a cancel arriving after the request ended
 * cannot reach the connection's next borrower.
 */
async function cancelJoinedStatement(txn: RequestTxn): Promise<void> {
  const at = txn.backend;
  if (!at) return;
  const { getActiveBunPool } = await import('../db/bun-sql-dialect.js');
  const cancel = getActiveBunPool()?.unsafe(
    `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE pid = $1 AND xact_start = $2::timestamptz`,
    [at.pid, at.started],
  );
  // Bounded: a pool too busy to lend a connection must not hold the caller's
  // answer; the guard above keeps a late one harmless.
  await Promise.race([cancel, Bun.sleep(5_000)]).catch((err: Error) =>
    console.error(`[worker-host] cancelling a timed-out request's statement: ${err.message}`),
  );
}

/**
 * The request transaction a worker route or action joins: the request's own
 * tenant transaction (`tenantMiddleware`), one per request, ordered by its turns
 * (`db/trx-sequencer.ts`) with the caller's statements and `db.transaction()`
 * scopes. Nothing outside a request's transaction — boot, timers, events, jobs
 * — and nothing once the request is ending.
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
    throw new Error("the request's transaction is over; a worker-isolated extension cannot join it");
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
  const joined: RequestTxn = { joined: true };
  const on = await transactionTurns(trx);
  // Every transaction `getDb()` opens is sequenced; one that is not cannot be
  // shared safely, and the call is refused rather than run beside it.
  if (!on) throw new Error("the request's transaction cannot be joined by a worker-isolated extension");
  // Read once, when the first call joins: a timeout then cancels what runs on
  // the connection (`cancelJoinedStatement`) without needing it.
  const { rows } = await on.send(
    CompiledQuery.raw('SELECT pg_backend_pid() AS pid, now()::text AS started', []),
  );
  joined.backend = rows[0] as { pid: number; started: string };
  // Ends before the request's transaction does: what is still queued is refused,
  // so no statement of the worker's lands after it.
  if (!beforeRequestTransactionEnds(() => endRequestTxn(joined, true))) {
    throw new Error("the request's transaction cannot be joined by a worker-isolated extension");
  }
  return joined;
}

/** Ceiling on a request's transaction across the bridge (RFC step 8). */
const REQUEST_TXN_TIMEOUT_MS = 30_000;
let requestTxnTimeoutMs = REQUEST_TXN_TIMEOUT_MS;

/**
 * The record of one worker request's transaction, ended once by
 * `endRequestTxn`: committed when the handler answered without throwing, rolled
 * back otherwise, on the hard timeout, and when the worker dies or is stopped
 * mid-request. No SQL crosses from a worker (RFC extension-model-v3 decision 2),
 * so it holds no connection of its own: what the worker writes through `host`
 * runs in the engine, in the request's tenant transaction.
 */
interface RequestTxn {
  /**
   * An inline request's own tenant transaction, joined by a call into a worker
   * (`joinRequestTxn`): never opened or ended here.
   */
  joined?: true;
  /**
   * Joined only: the backend holding the request's transaction, and when that
   * transaction began — what `cancelJoinedStatement` signals, and checks first.
   */
  backend?: { pid: number; started: string };
  closing?: Promise<boolean>;
}

function newRequestTxn(): RequestTxn {
  return {};
}

/**
 * End the request's transaction, once. Resolves true when what the request
 * wrote stands and false when it was rolled back; later calls get the first
 * answer.
 */
function endRequestTxn(txn: RequestTxn, commit: boolean): Promise<boolean> {
  txn.closing ??= Promise.resolve(commit);
  return txn.closing;
}
