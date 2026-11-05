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
  publishApiKeyActor,
  runOutsideTenantContext,
  withTenantIsolation,
} from '../tenancy/index.js';
import {
  compilePattern,
  type GatePrincipal,
  publicRouteRequest,
} from '../../middleware/extension-auth-gate.js';
import { compileInput, type DataIo, hostCollections, pairImplementations } from './actions.js';
import { ensureDeno } from './deno.js';
import { type HostCall, runInDeno } from './job-runner.js';
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
  runner?: { code: Uint8Array; memoryMb: number; timeoutSeconds: number };
}

/** What a queued job carries: everything it runs as, recorded at enqueue. */
interface JobPayload {
  tenantId: string;
  /** The enqueuing principal — a user id, `apikey:<uuid>`, or `ext:<name>:route` (ADR 0018). */
  enqueuedBy: string;
  /** The `"user"` row the job's writes are authored by (`rowAuthorId` of the enqueuer). */
  author: string | null;
  input: unknown;
}

/**
 * Each loaded extension's jobs, whether it holds `data:system`, and the signal
 * its unload aborts, which kills its runs in the Deno runner.
 */
const registered = new Map<
  string,
  { jobs: ReadonlyMap<string, CompiledJob>; system: boolean; unload: AbortController }
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
  if (worker) {
    for (const name of Object.keys(implemented)) {
      refuse(
        `job "${name}" runs in the Deno runner: export it from engine/jobs.ts, not the module's jobs`,
      );
    }
    if (declared.length === 0) return out;
    if (!jobsCode) {
      refuse(
        'its jobs run in the Deno runner, which needs engine/jobs.js and integrity.jobsSha256 ' +
          '(`zveltio extension pack` builds both from engine/jobs.ts)',
      );
    }
    for (const j of declared) {
      out.set(j.name, {
        ...common(j, compileInput('job', j, refuse)),
        runner: { code: jobsCode!, memoryMb: j.memoryMb, timeoutSeconds: j.timeoutSeconds },
      });
    }
    return out;
  }
  for (const { declared: j, input, run } of pairImplementations(
    'job',
    declared,
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
 * available: the jobs wait in their queues, they are not failed.
 */
async function pumpRunner(): Promise<void> {
  const boss = jobQueue();
  if (pumping || !boss || runnerQueues.size === 0) return;
  pumping = true;
  try {
    try {
      await ensureDeno();
    } catch (err) {
      if (!denoWarned) console.warn('[ext-jobs] runner jobs wait:', (err as Error).message);
      denoWarned = true;
      return;
    }
    let claimed = true;
    while (claimed && runnerBusy < RUNNER_CONCURRENCY) {
      claimed = false;
      for (const [q, { extName, job }] of runnerQueues) {
        if (runnerBusy >= RUNNER_CONCURRENCY) break;
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
 * `data:system`, and `input` matches the job's schema.
 */
export async function enqueueJob(
  extName: string,
  p: GatePrincipal,
  action: { name: string; enqueues: ReadonlySet<string> },
  job: string,
  input: unknown,
): Promise<string> {
  const refuse = (why: string): never => {
    throw new Error(`action "${action.name}" could not enqueue job "${job}": ${why}`);
  };
  if (!action.enqueues.has(job)) refuse('its manifest does not list it in enqueues');
  return sendJob(extName, job, input, refuse, p.trx, p.tenantId, p.user.id, rowAuthorId(p.user));
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
      "pass the request context `c` of a request to one of this extension's publicRoutes; " +
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
  const payload: JobPayload = { tenantId, enqueuedBy, author, input: parsed.data };
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
  const scopes = new Map<string, string[]>();
  for (const c of def.reads) scopes.set(c, ['read']);
  for (const c of def.writes)
    scopes.set(c, [...(scopes.get(c) ?? []), 'create', 'update', 'delete']);
  return {
    // `apikey:` so every check treats it as a key: scopes, not Casbin; no `"user"` row.
    id: `apikey:job:${extName}:${def.name}`,
    name: `${extName} job ${def.name}`,
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
    // Outside any tenant context (`work`), so the transaction's domain is this
    // tenant, not one inherited from wherever pg-boss resumed.
    await withTenantIsolation(tenantId, async (trx) => {
      await publishApiKeyActor(user.id, false, user.scopes);
      const collections = hostCollections(
        `job "${job}"`,
        def,
        jobData(extName, user, trx, tenantId),
      );
      if (!def.runner) return def.run!(input, { collections, timezone });
      await runInDeno({
        deno: await ensureDeno(),
        code: def.runner.code,
        job,
        input,
        timezone,
        memoryMb: def.runner.memoryMb,
        timeoutSeconds: def.runner.timeoutSeconds,
        signal: reg.unload.signal,
        call: (name, args) => hostCall(collections, name, args),
      });
    });
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
 * One host call from the Deno runner, as the inline job would make it. The
 * arguments come from code the operator did not write: each is checked for the
 * type the data API expects before it gets there. Who the call acts as is
 * already bound in `c`.
 */
async function hostCall(c: HostCollections, name: HostCall, a: unknown[]): Promise<unknown> {
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
  }
}

/** The data API as the job's principal, in its transaction, marked as `extName`'s job. */
function jobData(extName: string, user: RequestUser, trx: Database, tenantId: string): DataIo {
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
      writtenBy: extName,
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
