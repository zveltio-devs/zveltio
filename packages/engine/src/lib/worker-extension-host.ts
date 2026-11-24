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
 *   3. A worker reaches data through `host` (`host:call`); a `db:query` is
 *      refused from every worker (RFC extension-model-v3 decision 2).
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
 *   - Service registry bridge: workers can ctx.services.register() now;
 *     calls from other workers / inline extensions route through the
 *     host registry to the publishing worker.
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
import {
  callableDeps,
  reachableOwner,
  type ServiceDeps,
  serviceCallRefusal,
  serviceRegistry,
} from './service-registry.js';
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
  extensionLoader,
  guardEventHandler,
  refusalProblem,
  verifyRegistrySignedDir,
} from './extensions/index.js';
import type { ActionHost } from '@zveltio/sdk/extension';
import { compilePattern, extensionRequestRefused } from '../middleware/extension-auth-gate.js';
import { ProblemException, problem, problemOnError } from './problem.js';
import { ENGINE_EVENT_NAMESPACES, engineEvents } from './runtime/index.js';
import {
  beforeRequestTransactionEnds,
  describeDenial,
  getCurrentDomainOrNull,
  getCurrentTenantTrx,
  getCurrentTrxTenant,
  requestTransactionState,
  getRequestActor,
  getResolvedMembership,
  getUserRoles,
  NO_CALLER,
  type RequestActor,
  runOutsideTenantContext,
  runWithDomain,
  runWithoutTenantTrx,
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
  /** `c.get('user')` as the `/ext/*` gate left it: the one user `checkPermission` answers for. */
  user?: { id?: string };
  /** The request's async context — domain, tenant, the API key the gate admitted. */
  run?: <R>(fn: () => R) => R;
  /**
   * The route request this is, of which extension: what `host.collections`
   * answers for (ADR 0025). A service it calls copies the record, and another
   * extension is not this one.
   */
  route?: { extName: string; c: unknown };
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
  /**
   * An action run (ADR 0056): the `ActionHost` the engine built for it, which
   * answers its `host` calls, and the refusals it answered them with, by call
   * id, so one the action lets through is rethrown as it was raised.
   */
  action?: { host: ActionHost; refusals: Map<string, ProblemException> };
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
  /** A level-3 off-model refusal was logged for this process. */
  refusalLogged?: boolean;
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

/**
 * ADR 0056 d1 and amendment 2026-11-21: levels 3 and 2 are declared model only. Over the bridge that leaves an
 * action's `host` and a declared route's `host.collections`; what `register()`'s
 * ctx would send (`ctx.db`, `ctx.services`, `ctx.events`, `checkPermission`, …)
 * is refused here, whatever the worker's own runtime let through.
 */
function offModel(msg: WorkerToHostMessage): string | null {
  switch (msg.type) {
    case 'db:query':
      return 'ctx.db';
    case 'service:call':
    case 'service:register':
      return 'ctx.services';
    case 'host:call':
      return msg.op === 'action' || msg.op === 'collections' ? null : `ctx (${msg.op})`;
    default:
      return null;
  }
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
    dependencies: ReadonlySet<string>,
    mayCall: ServiceDeps,
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
        ...(signedLevel(source) !== null ? { declaredOnly: true as const } : {}),
        extName,
        env: {
          NODE_ENV: nodeEnv() ?? 'production',
          extensionPath: extDir,
        },
        config: source.config,
        routes: source.declaredRoutes ?? [],
        actions: source.actions ?? [],
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
    // Levels 3 and 2 serve their declared routes, whatever the worker says it registered.
    managed.routes =
      signedLevel(source) !== null
        ? (source.declaredRoutes ?? []).map(({ method, path }) => ({ method, path }))
        : (init.routes ?? []);
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
    const level = signedLevel(managed.source);
    // RFC extension-model-v3 decision 2 (phase D slice 4): no SQL crosses from
    // any worker, whatever signed it; the test override's unsigned one included.
    const off = msg.type === 'db:query' || level !== null ? offModel(msg) : null;
    if (off) {
      const error =
        level === null
          ? `${off} is refused: no SQL crosses from an extension process; it reaches its ` +
            `collections through host.collections (RFC extension-model-v3 decision 2)`
          : `${off} is refused: "${managed.name}" is signed by ${level === 3 ? 'an operator' : 'the registry'} ` +
            `key (level ${level}), which is declared model only — collections, actions, jobs, ` +
            `declared routes (ADR 0056)`;
      // Logged once per process: a bundle posting in a loop must not flood the log.
      if (!managed.refusalLogged) {
        managed.refusalLogged = true;
        console.error(
          `${boxTag(managed.name, managed.source)} ${error} (further refusals not logged)`,
        );
      }
      const type = {
        'db:query': 'db:err',
        'service:call': 'service:err',
        'service:register': 'service:register:err',
        'host:call': 'host:err',
      } as const;
      this.post(managed, {
        type: type[msg.type as keyof typeof type],
        id: (msg as { id: string }).id,
        error,
      } as HostToWorkerMessage);
      return;
    }
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
        console[msg.level](`${boxTag(managed.name, managed.source)} ${msg.message}`);
        break;
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
    let scope: InvokeScope = { tenantId: null };
    try {
      scope = requestScope(managed, msg.requestId, 'service call') ?? scope;
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
      const within = scope.txn ? scope.within : undefined;
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
      // that caller, for itself — with no caller, an actor with no identity
      // (ADR 0040). No request, no tenant: unchanged.
      // In a joined request transaction, at the caller's place in its turns: a
      // call made inside the worker's own `db.transaction()` runs in it, as the
      // statements beside it do, rather than wait for it to end.
      const run = (scope.txn?.joined && within) || scope.run || direct;
      const result = tenantId
        ? await run(() =>
            getCurrentTenantTrx() && getCurrentTrxTenant() === tenantId
              ? call()
              : runWithDomain(tenantId, () =>
                  withTenantIsolation(tenantId, call, {
                    ...actor,
                    identity: actor?.identity ?? NO_CALLER,
                  }),
                ),
          )
        : await run(call);
      this.post(managed, { type: 'service:ok', id: msg.id, result });
    } catch (err) {
      if (err instanceof ProblemException) scope.action?.refusals.set(msg.id, err);
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
    let scope: InvokeScope | undefined;
    try {
      scope = requestScope(managed, msg.requestId, msg.op);
      // In a joined request transaction, at the caller's place in its turns: a
      // query made for a call inside the worker's `db.transaction()` runs in it,
      // rather than wait for the scope that is waiting for this answer.
      const run = (scope?.txn?.joined && scope.within) || scope?.run || (<R>(fn: () => R) => fn());
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
          throw new Error(`unknown host call "${String(msg.op)}"`);
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
   * is called in: its tenant, caller and transaction, as a worker service an
   * inline route calls. `mountActions` made every check before this, and `host`
   * is the one it built: the worker's `host` calls are answered by it.
   */
  async runAction(extName: string, name: string, input: unknown, host: ActionHost) {
    const managed = this.workers.get(extName);
    if (!managed || managed.respawning) throw boxDown(extName, managed?.disabled);
    const scope = callerScope();
    try {
      return await this.invokeWorkerService(
        managed,
        name,
        [input, host.timezone],
        {
          ...scope,
          ...(inlineServiceTxn.getStore() ?? (await joinRequestTxn(scope))),
          action: { host, refusals: new Map() },
        },
        'action:invoke',
      );
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
        console.error(
          `${boxTag(managed.name, managed.source)} listener for "${event}" failed: ${err.message}`,
        ),
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
    type: 'service:invoke' | 'event:deliver' | 'action:invoke' = 'service:invoke',
  ): Promise<unknown> {
    const invokeId = rpcId('inv-svc');
    // In a request, a call into the box: counted, and refused past its limit.
    // An event delivery holds no request's connection.
    const leave = scope.txn ? this.admit(target, scope.txn) : () => {};
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
      type !== 'event:deliver'
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
        invokeWaiters.set(invokeId, {
          expect: target.name,
          resolve,
          reject,
          ...(type === 'action:invoke' ? { action: name } : {}),
        });
        setTimeout(
          () => {
            if (!invokeWaiters.has(invokeId)) return;
            invokeWaiters.delete(invokeId);
            // Its work is over: nothing more it sends runs as this request.
            target.invokeTenants.delete(invokeId);
            const what = `${type === 'action:invoke' ? 'action' : type === 'event:deliver' ? 'listener' : 'service'} "${name}"`;
            const err = this.timedOut(target, what);
            // Its statement cancelled first, while the request still holds the
            // connection: the caller's answer is what ends the request.
            if (scope.txn?.joined) void cancelJoinedStatement(scope.txn).finally(() => reject(err));
            else reject(err);
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
        // An action's refusal as it was raised: the engine's own, or one it threw.
        const raised = reply.hostError && scope.action?.refusals.get(reply.hostError);
        if (raised) throw raised;
        if (scope.action && reply.refusal) throw crossedRefusal(reply.refusal);
        const err = new Error(reply.error ?? 'service call failed');
        throw scope.action && reply.errno ? Object.assign(err, { errno: reply.errno }) : err;
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
          const user = (c.get('user') ?? undefined) as { id?: string } | undefined;
          const auth = live.source?.auth;
          const scope: InvokeScope = {
            ...currentScope(reqTenantId),
            user,
            run: AsyncLocalStorage.snapshot(),
            session: async () => auth?.api.getSession({ headers: c.req.raw.headers }) ?? null,
            route: { extName: managed.name, c },
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
            // Timed out, or the worker died: nothing it wrote is kept. Nor what
            // the request's tenant transaction holds for it — an inline service
            // it called wrote there: as for an inline route that threw,
            // `tenantMiddleware` rolls it back on `c.error`, and keeps this answer.
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
    /** An action run: its own extension stopping is not a dependency's. */
    action?: string;
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
    waiter.reject(
      waiter.action
        ? problem(
            'extension.unavailable',
            503,
            `extension "${extName}" stopped while running action "${waiter.action}"; nothing it wrote was kept`,
          )
        : dependencyDown(extName),
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

const DEPENDENCY_DOWN = 'extension.dependency_unavailable';

/** 503, so the HTTP caller sees "try again", not a server fault. */
function dependencyDown(extName: string): ProblemException {
  return problem(DEPENDENCY_DOWN, 503, `dependency "${extName}" is not running`);
}

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

function isDependencyDown(err: unknown): boolean {
  return err instanceof ProblemException && err.code === DEPENDENCY_DOWN;
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
  const joined: RequestTxn = { joined: true };
  const on = await transactionTurns(trx);
  // Every transaction `getDb()` opens is sequenced; one that is not cannot be
  // shared safely, and the call is refused rather than run beside it.
  if (!on) throw new Error("the request's transaction cannot be joined by a worker service");
  // Read once, when the first call joins: a timeout then cancels what runs on
  // the connection (`cancelJoinedStatement`) without needing it.
  const { rows } = await on.send(
    CompiledQuery.raw('SELECT pg_backend_pid() AS pid, now()::text AS started', []),
  );
  joined.backend = rows[0] as { pid: number; started: string };
  // Ends before the request's transaction does: what is still queued is refused,
  // so no statement of the worker's lands after it.
  if (!beforeRequestTransactionEnds(() => endRequestTxn(joined, true))) {
    throw new Error("the request's transaction cannot be joined by a worker service");
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
