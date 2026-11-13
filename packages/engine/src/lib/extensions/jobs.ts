/**
 * Extension jobs (RFC v3 "Jobs"): asynchronous work an action enqueues.
 *
 * The manifest declares each one — a JSON Schema input, the collections it reads
 * and writes, its retries — and the module implements it. `ActionHost.enqueue`
 * writes the job into pg-boss INSIDE the request transaction, so it commits or
 * rolls back with the action's own writes: an action that throws after
 * enqueueing leaves no job. pg-boss is the outbox; no table of our own.
 *
 * A job has no caller. It acts as the extension, with exactly its declared
 * collections: a key principal whose scopes are `reads` (read) and `writes`
 * (create, update, delete), through the data API — permissions, row rules,
 * column rules, hooks, revisions and audit are the route's, as for an API key.
 * That is authority no user handed it, so it needs `data:system` (owner
 * decision 2026-10-04). It runs in the tenant it was enqueued in, in a
 * transaction of its own; rows it writes are authored by the enqueuing user.
 *
 * A public route (an inbound signed webhook) enqueues too, through
 * `ctx.internals.enqueue`, for the jobs that name it in `fromPublicRoutes`
 * (ADR 0018): same outbox, same transaction, no user, so no author.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompiledQuery } from 'kysely';
import type { z } from 'zod';
import type {
  ExtensionJob,
  HostCollections,
  HostFiles,
  RequestUser,
  UpdateExpect,
  ZveltioExtension,
} from '@zveltio/sdk/extension';
import { getDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';
import { auditLog } from '../audit.js';
import {
  dataApiRead,
  dataApiWriteDetached,
  type JobQueue,
  jobQueue,
  onJobQueueStart,
  QUEUE_RETENTION,
  rowAuthorId,
} from '../data/index.js';
import { asEngineRole } from '../role-window.js';
import { withSavepoint } from '../savepoint.js';
import {
  createRequestScopedDb,
  effectiveTimeZone,
  beforeRequestTransactionEnds,
  issuerRowIdentity,
  keyIssuerRowActor,
  publishApiKeyActor,
  rowActor,
  runOutsideTenantContext,
  withTenantIsolation,
} from '../tenancy/index.js';
import {
  compilePattern,
  type GatePrincipal,
  publicRouteRequest,
} from '../../middleware/extension-auth-gate.js';
import {
  compileInput,
  type DataIo,
  hostCollections,
  pairImplementations,
  secretReveal,
} from './actions.js';
import { EGRESS_LIMITS, parseRequest, performEgress } from '../edge-functions/egress.js';
import { EGRESS_PREFIX, readGranted, slotBindings } from './consent.js';
import { type FileGrant, jobFiles } from './file-grants.js';
import { ensureDeno } from './deno.js';
import {
  fromBase64Strict,
  type HostCall,
  jobPlacement,
  runInDeno,
  runnerAnswers,
} from './job-runner.js';
import type { ExtensionManifest } from './manifest-schema.js';

export interface CompiledJob {
  name: string;
  input: z.ZodType;
  reads: ReadonlySet<string>;
  writes: ReadonlySet<string>;
  /** The `publicRoutes` entries that may enqueue it (`fromPublicRoutes`), compiled as the gate's. */
  fromPublicRoutes: readonly RegExp[];
  retry: { limit: number; backoff: boolean };
  /** Inline: the module's implementation, run in the engine. */
  run?: ExtensionJob;
  /** In the Deno runner (ADR 0022): the verified `jobs.js` and the run's ceilings. */
  runner?: {
    code: Uint8Array;
    memoryMb: number;
    timeoutSeconds: number;
    /** Declared authorities; reachable only once consented as `egress:<authority>`. */
    egress: readonly string[];
    /** Declared slots (ADR 0026), by name; each reaches what an operator bound to it. */
    egressSlots: readonly string[];
    /** Those of `egressSlots` declared `kind: "tcp"`: reached by a relayed stream, not fetch. */
    tcpSlots: readonly string[];
  };
}

/** What a queued job carries: everything it runs as, recorded at enqueue. */
interface JobPayload {
  tenantId: string;
  /** The enqueuing principal — a user id, `apikey:<uuid>`, or `ext:<name>:route` (ADR 0018). */
  enqueuedBy: string;
  /** The `"user"` row the job's writes are authored by (`rowAuthorId` of the enqueuer). */
  author: string | null;
  /**
   * The stored files the enqueuing user handed this job in the action request
   * (ADR 0032), checked as them then and again at each call. Absent: none.
   * Written by the engine on its own role, which neither the job nor
   * `zveltio_rls` can reach, so it is as trusted as the fields above.
   */
  files?: FileGrant;
  input: unknown;
}

/**
 * Each loaded extension's jobs, whether it holds `data:system`, and the signal
 * its unload aborts, which kills its runs in the Deno runner.
 */
const registered = new Map<
  string,
  {
    jobs: ReadonlyMap<string, CompiledJob>;
    system: boolean;
    /** Holds `files`: its jobs reach the stored files their user hands them (ADR 0032). */
    files: boolean;
    unload: AbortController;
  }
>();
/**
 * Queues this process works, each with the promise of its queue existing and its
 * worker started: a second start or register adds no second worker, and an
 * enqueue waits for the queue it writes into.
 */
const working = new Map<string, { ready: Promise<void> }>();
let listening = false;

/**
 * The Deno runner's queues, claimed by `pumpRunner` rather than a pg-boss
 * worker: a run is claimed only when a slot is free, so no job sits `active`
 * waiting for one — where `expireInSeconds` would end it and pg-boss retry it
 * while this instance still runs it, a side effect twice (ADR 0022 decision 6).
 */
const runnerQueues = new Map<string, { extName: string; job: string }>();
let RUNNER_CONCURRENCY = Math.max(1, Number(process.env.ZVELTIO_JOB_RUNNER_CONCURRENCY) || 4);
export function _setRunnerConcurrencyForTests(n: number): void {
  RUNNER_CONCURRENCY = n;
}
/** A claimed run's time beyond its `timeoutSeconds`: the tenant check, the transaction, the audit. */
const RUNNER_EXPIRE_MARGIN_S = 60;
let runnerBusy = 0;
let pumping = false;
let pumpTimer: ReturnType<typeof setInterval> | null = null;
let denoWarned = false;
const runnerDownWarned = new Set<string>();

export const jobQueueName = (extName: string, job: string): string => `ext.${extName}.${job}`;

/**
 * `engine/jobs.js` of the extension at `extDir`, when the manifest's
 * `integrity.jobsSha256` vouches for it; null when either is missing. Throws on
 * a mismatch: the bundle was changed after it was packed. Read once, at load:
 * every run gets a copy of THESE bytes, so a file replaced on disk never runs
 * against the definitions and grants it was not loaded with.
 */
export function verifiedJobsCode(
  extDir: string,
  manifest: ExtensionManifest | null,
): Uint8Array | null {
  const path = join(extDir, 'engine', 'jobs.js');
  const want = manifest?.integrity?.jobsSha256;
  if (!want || !existsSync(path)) return null;
  const code = readFileSync(path);
  const actual = createHash('sha256').update(code).digest('hex');
  if (actual !== want) {
    throw new Error(
      `engine/jobs.js hashes to ${actual}, not the manifest's integrity.jobsSha256 ${want}; ` +
        're-pack, or the bundle was tampered with',
    );
  }
  return new Uint8Array(code);
}

/**
 * Pair the manifest's jobs with their code; throws, refusing the load, on any
 * mismatch. A worker-isolated extension's jobs run in the Deno runner from
 * `jobsCode` (ADR 0022 decision 1); everything else's inline, from the module.
 */
export function compileJobs(
  extName: string,
  manifest: ExtensionManifest | null,
  extension: ZveltioExtension,
  worker: boolean,
  jobsCode: Uint8Array | null,
): Map<string, CompiledJob> {
  const declared = manifest?.jobs ?? [];
  const implemented = extension.jobs ?? {};
  const out = new Map<string, CompiledJob>();
  if (declared.length === 0 && Object.keys(implemented).length === 0) return out;
  const refuse = (why: string): never => {
    throw new Error(`Extension "${extName}": ${why}`);
  };
  const common = (j: (typeof declared)[number], input: z.ZodType) => ({
    name: j.name,
    input,
    reads: new Set(j.reads),
    writes: new Set(j.writes),
    fromPublicRoutes: (j.fromPublicRoutes ?? []).map(compilePattern),
    retry: j.retry,
  });
  // What it declares decides, not its name (ADR 0022 decision 1): egress exists
  // only in the runner, so a job that declares any runs there, first-party too.
  const inRunner = declared.filter(
    (j) => worker || (j.egress ?? []).length > 0 || (j.egressSlots ?? []).length > 0,
  );
  const inline = declared.filter((j) => !inRunner.includes(j));
  for (const j of inRunner) {
    if (Object.hasOwn(implemented, j.name)) {
      refuse(
        `job "${j.name}" runs in the Deno runner: export it from engine/jobs.ts, not the module's jobs`,
      );
    }
  }
  if (worker && Object.keys(implemented).length > 0) {
    refuse(
      `a worker-isolated extension's jobs run in the Deno runner: export them from engine/jobs.ts, not the module's jobs`,
    );
  }
  if (inRunner.length > 0 && !jobsCode) {
    refuse(
      `job "${inRunner[0]!.name}" runs in the Deno runner, which needs engine/jobs.js and ` +
        'integrity.jobsSha256 (`zveltio extension pack` builds both from engine/jobs.ts)',
    );
  }
  for (const j of inRunner) {
    out.set(j.name, {
      ...common(j, compileInput('job', j, refuse)),
      runner: {
        code: jobsCode!,
        memoryMb: j.memoryMb,
        timeoutSeconds: j.timeoutSeconds,
        egress: j.egress ?? [],
        egressSlots: (j.egressSlots ?? []).map((s) => (typeof s === 'string' ? s : s.name)),
        tcpSlots: (j.egressSlots ?? []).flatMap((s) =>
          typeof s !== 'string' && s.kind === 'tcp' ? [s.name] : [],
        ),
      },
    });
  }
  for (const { declared: j, input, run } of pairImplementations(
    'job',
    inline,
    implemented,
    refuse,
  )) {
    out.set(j.name, { ...common(j, input), run });
  }
  return out;
}

/** Make `extName`'s jobs runnable (and enqueueable), working their queues once pg-boss runs. */
export function registerJobs(
  extName: string,
  jobs: ReadonlyMap<string, CompiledJob>,
  capabilities: readonly string[],
): void {
  if (jobs.size === 0) return;
  registered.set(extName, {
    jobs,
    system: capabilities.includes('data:system'),
    files: capabilities.includes('files'),
    unload: new AbortController(),
  });
  // Subscribed on first use, not at import: in the compiled binary this module
  // can be evaluated before ddl-queue's, whose listener list is not there yet.
  if (!listening) {
    listening = true;
    onJobQueueStart(async (boss) => {
      working.clear();
      for (const name of registered.keys()) work(boss, name);
      await Promise.all([...working.values()].map((w) => w.ready));
    });
    return;
  }
  const boss = jobQueue();
  if (boss) work(boss, extName);
}

/** Stop working `extName`'s queues. Queued jobs stay, for when it loads again. */
export async function unregisterJobs(extName: string): Promise<void> {
  const reg = registered.get(extName);
  if (!reg) return;
  registered.delete(extName);
  // Its runs in the Deno runner die first: each is a failed attempt, retried
  // when it loads again. Runner queues have no pg-boss worker to stop.
  reg.unload.abort();
  const boss = jobQueue();
  // Taken before the first await: a load that registers again meanwhile starts
  // workers of its own, which this loop must not stop.
  const taken: [string, { ready: Promise<void> }][] = [];
  for (const job of reg.jobs.keys()) {
    const q = jobQueueName(extName, job);
    const entry = working.get(q);
    if (!entry) continue;
    working.delete(q);
    runnerQueues.delete(q);
    taken.push([q, entry]);
  }
  for (const [q, entry] of taken) {
    // A start still in flight sees it is no longer this registration's and adds
    // no worker; one already past that point is stopped here.
    await entry.ready.catch(() => undefined);
    if (working.has(q)) continue;
    if (boss) await boss.offWork(q).catch((err: Error) => warn(extName, err));
  }
}

/**
 * Claim runner jobs while slots are free. Nothing is claimed until Deno is
 * available, nor in production without the extension runner to run it on
 * (ADR 0023 decision 2): the jobs wait in their queues, they are not failed.
 */
async function pumpRunner(): Promise<void> {
  const boss = jobQueue();
  if (pumping || !boss || runnerQueues.size === 0) return;
  pumping = true;
  try {
    try {
      jobPlacement();
      await ensureDeno();
    } catch (err) {
      if (!denoWarned) console.warn('[ext-jobs] runner jobs wait:', (err as Error).message);
      denoWarned = true;
      return;
    }
    // Asked once per extension per pass: a queue whose runner is down is not claimed from.
    const answers = new Map<string, Promise<boolean>>();
    let claimed = true;
    while (claimed && runnerBusy < RUNNER_CONCURRENCY) {
      claimed = false;
      for (const [q, { extName, job }] of runnerQueues) {
        if (runnerBusy >= RUNNER_CONCURRENCY) break;
        if (!answers.has(extName)) answers.set(extName, runnerAnswers(extName));
        if (!(await answers.get(extName))) {
          if (!runnerDownWarned.has(extName)) {
            runnerDownWarned.add(extName);
            console.warn(`[ext-jobs] ${extName}: its runner does not answer; its jobs wait`);
          }
          continue;
        }
        runnerDownWarned.delete(extName);
        const [j] = await boss.fetch<JobPayload>(q, { batchSize: 1 });
        if (!j) continue;
        claimed = true;
        runnerBusy++;
        void runOutsideTenantContext(() => runJob(extName, job, j.id, j.data))
          .then(
            () => boss.complete(q, j.id),
            (err: Error) => boss.fail(q, j.id, { message: err?.message ?? String(err) }),
          )
          .catch((err: Error) => warn(extName, err))
          .finally(() => {
            runnerBusy--;
            void pumpRunner();
          });
      }
    }
  } catch (err) {
    console.warn('[ext-jobs] runner:', (err as Error)?.message ?? err);
  } finally {
    pumping = false;
  }
}

function work(boss: JobQueue, extName: string): void {
  for (const job of registered.get(extName)?.jobs.keys() ?? []) {
    const q = jobQueueName(extName, job);
    if (working.has(q)) continue;
    const entry = { ready: Promise.resolve() };
    entry.ready = (async () => {
      await boss.createQueue(q, QUEUE_RETENTION);
      // Unloaded while the queue was created (`unregisterJobs` took the entry): no worker.
      if (!registered.has(extName) || working.get(q) !== entry) return;
      if (registered.get(extName)?.jobs.get(job)?.runner) {
        runnerQueues.set(q, { extName, job });
        pumpTimer ??= setInterval(() => void pumpRunner(), 2000);
        pumpTimer.unref?.();
        void pumpRunner();
        return;
      }
      // Outside whatever context pg-boss resumes its loop in (see ddl-queue's `work`).
      await boss.work<JobPayload>(q, ([j]) =>
        runOutsideTenantContext(() => runJob(extName, job, j!.id, j!.data)),
      );
    })();
    working.set(q, entry);
    entry.ready.catch((err: Error) => {
      // Not left as worked: the next start or register tries again.
      if (working.get(q) === entry) working.delete(q);
      warn(extName, err);
    });
  }
}

/**
 * `ActionHost.enqueue`: queue `job` for `extName` in the request transaction.
 * Refused unless the action lists the job in `enqueues`, the extension holds
 * `data:system`, and `input` matches the job's schema. `files`: the request's
 * `$files`, which the action passes to this one job (ADR 0032).
 */
export async function enqueueJob(
  extName: string,
  p: GatePrincipal,
  action: { name: string; enqueues: ReadonlySet<string> },
  job: string,
  input: unknown,
  files?: FileGrant,
): Promise<string> {
  const refuse = (why: string): never => {
    throw new Error(`action "${action.name}" could not enqueue job "${job}": ${why}`);
  };
  if (!action.enqueues.has(job)) refuse('its manifest does not list it in enqueues');
  return sendJob(
    extName,
    job,
    input,
    refuse,
    p.trx,
    p.tenantId,
    p.user.id,
    rowAuthorId(p.user),
    files,
  );
}

/**
 * `ctx.internals.enqueue`: queue `job` for `extName` from a request to one of
 * its `publicRoutes`, in that request's transaction and tenant (ADR 0018).
 * Refused unless `c` is that request, the job names the route in
 * `fromPublicRoutes`, and as `enqueueJob` otherwise. No user enqueued it, so
 * its writes have no author. Audited on the same transaction, so the row
 * exists exactly when the job does.
 */
export async function enqueueFromPublicRoute(
  extName: string,
  c: unknown,
  job: string,
  input: unknown,
): Promise<string> {
  const refuse = (why: string): never => {
    throw new Error(`ext:${extName}: ctx.internals.enqueue could not enqueue "${job}": ${why}`);
  };
  const req = publicRouteRequest(c);
  if (!req || req.extName !== extName) {
    return refuse(
      "pass the request context `c` (or the declared handler's `Request`) of a request to one of this extension's publicRoutes; " +
        'only such a request enqueues from a route (an action enqueues with host.enqueue)',
    );
  }
  const def = registered.get(extName)?.jobs.get(job);
  if (def && !def.fromPublicRoutes.some((re) => re.test(req.sub))) {
    refuse(`its manifest does not name this route (${req.sub}) in the job's fromPublicRoutes`);
  }
  // Held open until the enqueue is done, before its first await: one the
  // handler did not await would otherwise send its INSERT after the COMMIT.
  // Refused once the request is ending (work left running after its answer).
  let done = () => {};
  const held = new Promise<void>((resolve) => {
    done = resolve;
  });
  if (!beforeRequestTransactionEnds(() => held)) refuse('its request is over');
  try {
    const enqueuedBy = `ext:${extName}:route`;
    // No user, so no files (ADR 0032): nobody handed any.
    const id = await sendJob(extName, job, input, refuse, req.trx, req.tenantId, enqueuedBy, null);
    const { trx } = req;
    // `sendJob` refused a request without one; a failed audit INSERT must not abort the request.
    if (trx) {
      await withSavepoint(
        trx,
        'route_enqueue_audit',
        () =>
          auditLog(trx, {
            type: 'extension.job.enqueued',
            resourceType: 'extension_job',
            resourceId: `${extName}:${job}`,
            metadata: { extension: `ext:${extName}`, job, jobId: id, enqueuedBy, route: req.sub },
          }),
        () => undefined,
      );
    }
    return id;
  } finally {
    done();
  }
}

/** The enqueue both doors share: the job, its capability, its input, then pg-boss's INSERT on `trx`. */
async function sendJob(
  extName: string,
  job: string,
  input: unknown,
  refuse: (why: string) => never,
  trx: Database | undefined,
  tenantId: string | null,
  enqueuedBy: string,
  author: string | null,
  files?: FileGrant,
): Promise<string> {
  const reg = registered.get(extName);
  const def = reg?.jobs.get(job);
  if (!reg || !def) return refuse(`${extName} declares no such job`);
  if (!reg.system) refuse('a job acts beyond its caller, which needs the data:system capability');
  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    refuse(`its input does not match the job's schema (${JSON.stringify(parsed.error.issues)})`);
  }
  if (!trx) return refuse('this request holds no transaction');
  if (!tenantId) return refuse('this request runs in no tenant');
  const boss = jobQueue();
  if (!boss) return refuse('the job queue is not running');
  // Loaded a moment ago, its queue may still be being created.
  const queue = working.get(jobQueueName(extName, job));
  if (!queue) return refuse('its queue is not being worked');
  await queue.ready;
  const payload: JobPayload = {
    tenantId,
    enqueuedBy,
    author,
    ...(files ? { files } : {}),
    input: parsed.data,
  };
  // pg-boss's own INSERT, on the request transaction: committed or rolled back
  // with it. As the engine's role — `zveltio_rls` holds nothing on `pgboss`, and
  // granting it would let any tenant statement queue the engine's DDL jobs.
  const id = await asEngineRole(trx, () =>
    boss.send(jobQueueName(extName, job), payload as object, {
      retryLimit: def.retry.limit,
      retryBackoff: def.retry.backoff,
      retryDelay: 1,
      // Claimed only when a runner slot is free (`pumpRunner`), so this bounds the run itself.
      ...(def.runner
        ? { expireInSeconds: def.runner.timeoutSeconds + RUNNER_EXPIRE_MARGIN_S }
        : {}),
      db: {
        executeSql: (text, values) =>
          trx.executeQuery(CompiledQuery.raw(text, values ?? [])) as Promise<{ rows: never[] }>,
      },
    }),
  );
  if (!id) refuse('pg-boss returned no job id');
  return id as string;
}

/** The job's principal: the extension, as a key holding the job's declared collections. */
function jobPrincipal(extName: string, def: CompiledJob, author: string | null): RequestUser {
  return extensionPrincipal(
    `apikey:job:${extName}:${def.name}`,
    `${extName} job ${def.name}`,
    def,
    author,
  );
}

/**
 * The extension acting as itself: a key holding `reads` (read) and `writes`
 * (create, update, delete). `id` starts `apikey:job:`, which the checks read as
 * an extension bounded by its manifest, with no issuer (`keyIssuerAllows`).
 */
export function extensionPrincipal(
  id: `apikey:job:${string}`,
  name: string,
  def: { reads: Iterable<string>; writes: Iterable<string> },
  author: string | null,
): RequestUser {
  const scopes = new Map<string, string[]>();
  for (const c of def.reads) scopes.set(c, ['read']);
  for (const c of def.writes)
    scopes.set(c, [...(scopes.get(c) ?? []), 'create', 'update', 'delete']);
  return {
    // `apikey:` so every check treats it as a key: scopes, not Casbin; no `"user"` row.
    id,
    name,
    role: 'api_key',
    scopes: [...scopes].map(([collection, actions]) => ({ collection, actions })),
    rlsBypass: false,
    authorUserId: author,
  };
}

async function runJob(extName: string, job: string, id: string, data: JobPayload): Promise<void> {
  let failure: string | undefined;
  let tenantExists = true;
  try {
    const reg = registered.get(extName);
    const def = reg?.jobs.get(job);
    // Retried: the extension may be loading again.
    if (!reg || !def) throw new Error(`${extName} has no job "${job}" loaded`);
    if (!reg.system) throw new Error(`${extName} no longer holds data:system`);
    const input = def.input.parse(data.input);
    const { tenantId } = data;
    // Purged or suspended since the enqueue: not run, and not retried — a
    // retry cannot bring the tenant back. Recorded as a failure below.
    const tenant = await getDb()
      .selectFrom('zv_tenants')
      .select('status')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (tenant?.status !== 'active') {
      tenantExists = tenant !== undefined;
      failure = `tenant ${tenantId} is ${tenant?.status ?? 'gone'}; the job did not run`;
      return;
    }
    const user = jobPrincipal(extName, def, data.author);
    // On the pool, as the status above: the job's transaction runs as the tenant.
    const timezone = await effectiveTimeZone(getDb(), tenantId);
    // Whom its row rules' `user_id`/`user_email` resolve to (ADR 0028): the
    // enqueuing user, `''` for a job with none — and that user's own row rules,
    // ANDed on as a member key's issuer's are, so the job never sees past them.
    // Before any transaction, on the pool.
    const [author, issuerRows] = await Promise.all([rowActor(user), keyIssuerRowActor(user)]);
    const issuer = issuerRowIdentity(issuerRows);
    // Outside any tenant context (`work`), so the transaction's domain is this
    // tenant, not one inherited from wherever pg-boss resumed.
    const { runner } = def;
    // This attempt's `host.files` (ADR 0032), across its transactions: the byte
    // budget, and whether it has put its one file.
    const fileRun = { bytes: 0, put: false };
    // In `tenantId`'s transaction, as the job's principal: the run's, or one per call.
    // A put's bytes follow the transaction: removed if it rolls back.
    const inTenant = async <T>(fn: (h: JobCallHost) => Promise<T>): Promise<T> => {
      const effects = txEffects();
      let out: T;
      try {
        out = await withTenantIsolation(tenantId, async (trx) => {
          await publishApiKeyActor(user.id, false, user.scopes, undefined, '', issuer, author);
          return fn({
            collections: hostCollections(
              `job "${job}"`,
              def,
              jobData(user, trx, tenantId, extName),
              secretReveal(trx, tenantId, extName),
            ),
            files: jobFiles({
              extName,
              held: reg.files,
              trx,
              tenantId,
              jobId: id,
              enqueuedBy: data.enqueuedBy,
              author: data.author,
              grant: data.files,
              run: fileRun,
              onRollback: effects.afterRollback,
            }),
          });
        });
      } catch (err) {
        await effects.settle(false);
        throw err;
      }
      await effects.settle(true);
      return out;
    };
    // At most two file calls of a run at once: each holds its bytes whole.
    const fileCalls = limiter(Number.POSITIVE_INFINITY, 2, 'file calls');
    const call = (h: JobCallHost, name: HostCall, args: unknown[]) =>
      name.startsWith('files.') ? fileCalls(() => jobCall(h, name, args)) : jobCall(h, name, args);
    if (!runner) {
      await inTenant(({ collections, files }) => def.run!(input, { collections, timezone, files }));
      return;
    }
    const deno = await ensureDeno();
    const run = (call: (n: HostCall, a: unknown[]) => Promise<unknown>) =>
      runInDeno({
        extName,
        deno,
        code: runner.code,
        job,
        input,
        timezone,
        memoryMb: runner.memoryMb,
        timeoutSeconds: runner.timeoutSeconds,
        signal: reg.unload.signal,
        call,
      });
    // No egress: one transaction for the run, as inline. A failure rolls it all back.
    if (runner.egress.length === 0 && runner.egressSlots.length === 0) {
      await inTenant((h) =>
        run((name, args) =>
          name === 'fetch'
            ? Promise.reject(new Error('this job declares no egress'))
            : call(h, name, args),
        ),
      );
      return;
    }
    // Egress (ADR 0022 decision 4): a run can last minutes, so no transaction
    // spans it; each host call opens its own, in the tenant, never on the pool,
    // after checking the tenant is still active.
    const fetches = limiter(EGRESS_LIMITS.requests, EGRESS_LIMITS.inFlight, 'requests');
    // Each call holds a pool connection: a run must not take the pool from every other tenant.
    const dbCalls = limiter(Number.POSITIVE_INFINITY, 2, 'host calls');
    const writing = new Set<Promise<unknown>>();
    // Created by the run's first connect; every stream it opened is closed when the run ends.
    const streams: { relay: import('./tcp-relay.js').TcpRelay | null } = { relay: null };
    const tcp = async (name: HostCall, args: unknown[]): Promise<unknown> => {
      if (name === 'tcp.connect') {
        const slot = args[0];
        if (typeof slot !== 'string' || !runner.tcpSlots.includes(slot)) {
          throw new Error(`tcp.connect: job "${job}" declares no tcp slot "${String(slot)}"`);
        }
        // The consent as recorded now, as for a fetch: a rebinding cuts the next connect.
        const binding = slotBindings(await readGranted(getDb(), extName), new Set([slot])).get(
          slot,
        );
        if (!binding) throw new Error(`tcp.connect: slot "${slot}" is not bound`);
        const mod = await loadTcpRelay();
        const target = mod.parseTarget(args[1]);
        // Ended while this connect waited: no relay is created after closeAll.
        if (ended.signal.aborted) throw new Error('tcp.connect: the run has ended');
        streams.relay ??= new mod.TcpRelay();
        return streams.relay.connect(target, binding);
      }
      const relay = streams.relay;
      if (!relay) throw new Error(`${name}: no open stream`);
      switch (name) {
        case 'tcp.read': {
          const bytes = await relay.read(args[0], args[1]);
          return bytes === null ? null : Buffer.from(bytes).toString('base64');
        }
        case 'tcp.write':
          if (typeof args[1] !== 'string') throw new Error('tcp.write: data is base64 text');
          await relay.write(args[0], Buffer.from(args[1], 'base64'));
          return null;
        case 'tcp.startTls':
          await relay.startTls(args[0]);
          return null;
        case 'tcp.close':
          relay.close(args[0]);
          return null;
      }
      throw new Error(`${name} is not a tcp call`);
    };
    const ended = new AbortController();
    const abort = () => ended.abort();
    reg.unload.signal.addEventListener('abort', abort);
    try {
      await run(async (name, args) => {
        if (name === 'fetch') {
          return fetches(async () => {
            // The consent as recorded now, not as it was at load (ADR 0023
            // decision 4): a revocation or a rebinding cuts the next fetch. On
            // the pool, as the tenant check below: an instance row, read before
            // the fetch, so no transaction is held across it. No row
            // (uninstalled) or no consent recorded: no egress — it is never
            // grandfathered.
            const { allowed, privateList } = jobEgress(runner, await readGranted(getDb(), extName));
            return jobFetch(allowed, privateList, args[0], ended.signal);
          });
        }
        if (name.startsWith('tcp.')) return tcp(name, args);
        if (name === 'egress.slot') {
          const slot = args[0];
          if (typeof slot !== 'string' || !runner.egressSlots.includes(slot)) {
            throw new Error(`egress.slot: job "${job}" declares no egress slot "${String(slot)}"`);
          }
          const granted = await readGranted(getDb(), extName);
          return slotBindings(granted, new Set([slot])).get(slot)?.authorities ?? [];
        }
        const p = (name.startsWith('files.') ? fileCalls : passThrough)(() =>
          dbCalls(async () => {
            const now = await getDb()
              .selectFrom('zv_tenants')
              .select('status')
              .where('id', '=', tenantId)
              .executeTakeFirst();
            if (now?.status !== 'active') throw new Error(`tenant ${tenantId} is no longer active`);
            return inTenant((h) => jobCall(h, name, args));
          }),
        );
        writing.add(p);
        void p.finally(() => writing.delete(p)).catch(() => undefined);
        return p;
      });
    } finally {
      reg.unload.signal.removeEventListener('abort', abort);
      ended.abort();
      streams.relay?.closeAll();
      // Their transactions commit on their own: the outcome is recorded after
      // the last one settles, so a retry never starts beside a write still landing.
      await Promise.allSettled([...writing]);
    }
  } catch (err) {
    failure = (err as Error)?.message ?? String(err);
    throw err;
  } finally {
    await auditRun(extName, job, id, data, failure, tenantExists);
  }
}

/**
 * The run's audit row, on the pool after the job's transaction, so a failure's
 * row survives its rollback. `auditLog` swallows a failed write, so nothing it
 * would refuse is handed to it: `user_id` references `"user"`, and the author
 * may have been deleted since the enqueue — the ids go in the metadata always.
 */
async function auditRun(
  extName: string,
  job: string,
  id: string,
  data: JobPayload,
  failure: string | undefined,
  tenantExists: boolean,
): Promise<void> {
  const author = data.author
    ? await getDb()
        .selectFrom('user')
        .select('id')
        .where('id', '=', data.author)
        .executeTakeFirst()
        .then((r) => r?.id)
        .catch(() => undefined)
    : undefined;
  await auditLog(getDb(), {
    type: 'extension.job.executed',
    // A key enqueuer with no issuer row: `auditLog` moves `apikey:…` into the metadata.
    userId: author ?? (data.enqueuedBy.startsWith('apikey:') ? data.enqueuedBy : undefined),
    resourceType: 'extension_job',
    resourceId: `${extName}:${job}`,
    metadata: {
      extension: extName,
      job,
      jobId: id,
      enqueuedBy: data.enqueuedBy,
      author: data.author,
      tenantId: data.tenantId,
      outcome: failure === undefined ? 'success' : 'failure',
      ...(failure === undefined ? {} : { error: failure.slice(0, 500) }),
    },
    // A purged tenant's trail went with it; the instance's keeps this row.
    tenantId: tenantExists ? data.tenantId : null,
  });
}

/**
 * The relay module, imported on the first `tcp.connect` of a bound slot (ADR
 * 0026 amendment, decision 4): an engine with no tcp binding never loads it.
 */
let tcpRelayModule: Promise<typeof import('./tcp-relay.js')> | null = null;
const loadTcpRelay = () => (tcpRelayModule ??= import('./tcp-relay.js'));
/** Tests: whether any run has loaded the relay. */
export const _tcpRelayLoadedForTests = (): boolean => tcpRelayModule !== null;

/** A `limiter` that limits nothing. */
const passThrough = <T>(fn: () => Promise<T>): Promise<T> => fn();

/** Seconds one fetch may take, its body included. */
const FETCH_TIMEOUT_S = 30;

/**
 * One run's budget for a kind of call: at most `max` in all and `inFlight` at
 * once (the rest wait). Fetches get the edge function's (50, 6).
 */
function limiter(max: number, inFlight: number, what: string) {
  let total = 0;
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (++total > max) throw new Error(`[egress] more than ${max} ${what} in one run`);
    while (active >= inFlight) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * The job's `fetch`: the edge-function egress bridge's request, held to the
 * job's CONSENTED authorities on every redirect hop, the SSRF guard, and an
 * address pinned even behind a configured proxy. Answers the bridge's answer
 * without its id; a refusal is the job's error.
 */
/**
 * What a run of the job may reach under `granted`: each declared authority
 * consented as `egress:<authority>`, and each authority bound to a declared
 * slot (ADR 0026). `privateList` holds the bound ones marked private.
 */
export function jobEgress(
  runner: { egress: readonly string[]; egressSlots: readonly string[] },
  granted: readonly string[] | null,
): { allowed: string[]; privateList: string[] } {
  const set = new Set(granted ?? []);
  const bound = [...slotBindings(granted, new Set(runner.egressSlots)).values()];
  return {
    allowed: [
      ...new Set([
        ...runner.egress.filter((a) => set.has(`${EGRESS_PREFIX}${a}`)),
        ...bound.flatMap((b) => b.authorities),
      ]),
    ],
    privateList: bound.filter((b) => b.private).flatMap((b) => b.authorities),
  };
}

async function jobFetch(
  allowed: readonly string[],
  privateList: readonly string[],
  arg: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const req = parseRequest(JSON.stringify({ ...(arg as object), id: 0 }));
  if (!req) throw new Error('fetch: malformed request');
  const a = await performEgress(
    req,
    allowed,
    AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_S * 1000)]),
    true,
    privateList,
  );
  if (!a.ok) throw new Error(a.error);
  const { id: _, ...answer } = a;
  return answer;
}

/**
 * One host call from the Deno runner, as the inline job would make it. The
 * arguments come from code the operator did not write: each is checked for the
 * type the data API expects before it gets there. Who the call acts as is
 * already bound in `c`.
 */
export async function hostCall(c: HostCollections, name: HostCall, a: unknown[]): Promise<unknown> {
  const str = (i: number, what: string): string => {
    if (typeof a[i] !== 'string') throw new Error(`${name}: ${what} must be a string`);
    return a[i] as string;
  };
  const obj = (i: number, what: string): Record<string, unknown> => {
    const v = a[i];
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`${name}: ${what} must be an object`);
    }
    return v as Record<string, unknown>;
  };
  switch (name) {
    case 'collections.read':
      return c.read(str(0, 'collection'), str(1, 'id'));
    case 'collections.list':
      return c.list(str(0, 'collection'), obj(1, 'query'));
    case 'collections.insert':
      return c.insert(str(0, 'collection'), obj(1, 'data'));
    case 'collections.update': {
      const { expect } = obj(3, 'options');
      const scalar = (v: unknown) =>
        v === null || ['string', 'number', 'boolean'].includes(typeof v);
      if (
        expect !== undefined &&
        (expect === null ||
          typeof expect !== 'object' ||
          !Object.values(expect).every((vs) => Array.isArray(vs) && vs.every(scalar)))
      ) {
        throw new Error(`${name}: options.expect maps fields to lists of scalars`);
      }
      return c.update(str(0, 'collection'), str(1, 'id'), obj(2, 'data'), {
        expect: expect as UpdateExpect | undefined,
      });
    }
    case 'collections.delete':
      return c.delete(str(0, 'collection'), str(1, 'id'));
    case 'fetch':
      throw new Error('fetch is not a collection call');
    case 'egress.slot':
      throw new Error('this job declares no egress slot');
    case 'tcp.connect':
    case 'tcp.read':
    case 'tcp.write':
    case 'tcp.startTls':
    case 'tcp.close':
      throw new Error('this job declares no tcp slot');
    case 'files.put':
    case 'files.get':
      throw new Error(`${name} is not a collection call`);
  }
}

/** What one host call of a run reaches, in the transaction it runs in. */
interface JobCallHost {
  collections: HostCollections;
  files: HostFiles;
}

/** One Deno runner call: `files.*` to `h.files`, its bytes as base64 on the channel; the rest to `hostCall`. */
async function jobCall(h: JobCallHost, name: HostCall, a: unknown[]): Promise<unknown> {
  if (!name.startsWith('files.')) return hostCall(h.collections, name, a);
  const str = (i: number, what: string): string => {
    if (typeof a[i] !== 'string') throw new Error(`${name}: ${what} must be a string`);
    return a[i] as string;
  };
  switch (name) {
    case 'files.put':
      return h.files.put(fromBase64Strict(str(0, 'bytes'), 'files.put: bytes'));
    case 'files.get': {
      const f = await h.files.get(str(0, 'id'));
      return f && { ...f, bytes: Buffer.from(f.bytes).toString('base64') };
    }
  }
  throw new Error(`${name} is not a files call`);
}

/**
 * What a transaction's rollback undoes outside it (a put's bytes), run once it
 * settles; one registered after a rollback runs at once, after a commit never.
 */
function txEffects() {
  type Fn = () => Promise<unknown>;
  let state: 'open' | 'committed' | 'rolled-back' = 'open';
  const queued: Fn[] = [];
  const run = (fns: Fn[]) =>
    Promise.all(
      fns.map((fn) =>
        fn().catch((err: Error) => console.warn('[ext-jobs] host.files:', err?.message ?? err)),
      ),
    );
  return {
    afterRollback: (fn: Fn) => {
      if (state === 'open') queued.push(fn);
      else if (state === 'rolled-back') void run([fn]);
    },
    settle: async (committed: boolean) => {
      state = committed ? 'committed' : 'rolled-back';
      if (!committed) await run(queued);
    },
  };
}

/**
 * The data API as `user`, an extension's principal, in `trx`. Writes carry
 * `writtenBy` (a job's: its extension's mark; a route's: none).
 */
export function jobData(
  user: RequestUser,
  trx: Database,
  tenantId: string,
  writtenBy: string | undefined,
): DataIo {
  const db = createRequestScopedDb(getDb());
  const who = { user, authType: 'api_key' as const, trx, tenantId };
  const write = async (
    op: 'create' | 'update' | 'delete',
    collection: string,
    id: string,
    data: Record<string, unknown>,
    expect?: UpdateExpect,
  ) => {
    const res = await dataApiWriteDetached(op, db, {
      ...who,
      collection,
      id,
      body: async () => data,
      expect,
      writtenBy,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const read = async (collection: string, id: string | null, query?: object) => {
    const res = await dataApiRead(db, who, collection, id, query);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return {
    read: (collection, id) => read(collection, id),
    list: (collection, query) => read(collection, null, query),
    create: (collection, data) => write('create', collection, '', data),
    update: (collection, id, data, expect) => write('update', collection, id, data, expect),
    delete: (collection, id) => write('delete', collection, id, {}),
  };
}

function warn(extName: string, err: Error): void {
  console.warn(`[ext-jobs] ${extName}:`, err?.message ?? err);
}
