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
 */

import { CompiledQuery } from 'kysely';
import type { z } from 'zod';
import type {
  ExtensionJob,
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
import {
  createRequestScopedDb,
  publishApiKeyActor,
  runOutsideTenantContext,
  withTenantIsolation,
} from '../tenancy/index.js';
import type { GatePrincipal } from '../../middleware/extension-auth-gate.js';
import { type DataIo, hostCollections, pairImplementations } from './actions.js';
import type { ExtensionManifest } from './manifest-schema.js';

export interface CompiledJob {
  name: string;
  input: z.ZodType;
  reads: ReadonlySet<string>;
  writes: ReadonlySet<string>;
  retry: { limit: number; backoff: boolean };
  run: ExtensionJob;
}

/** What a queued job carries: everything it runs as, recorded at enqueue. */
interface JobPayload {
  tenantId: string;
  /** The enqueuing principal — a user id or `apikey:<uuid>`. */
  enqueuedBy: string;
  /** The `"user"` row the job's writes are authored by (`rowAuthorId` of the enqueuer). */
  author: string | null;
  input: unknown;
}

/** Each loaded extension's jobs, and whether it holds `data:system`. */
const registered = new Map<string, { jobs: ReadonlyMap<string, CompiledJob>; system: boolean }>();
/**
 * Queues this process works, each with the promise of its queue existing and its
 * worker started: a second start or register adds no second worker, and an
 * enqueue waits for the queue it writes into.
 */
const working = new Map<string, { ready: Promise<void> }>();
let listening = false;

export const jobQueueName = (extName: string, job: string): string => `ext.${extName}.${job}`;

/** Pair the manifest's jobs with the module's; throws, refusing the load, on any mismatch. */
export function compileJobs(
  extName: string,
  manifest: ExtensionManifest | null,
  extension: ZveltioExtension,
  worker: boolean,
): Map<string, CompiledJob> {
  const declared = manifest?.jobs ?? [];
  const implemented = extension.jobs ?? {};
  const out = new Map<string, CompiledJob>();
  if (declared.length === 0 && Object.keys(implemented).length === 0) return out;
  const refuse = (why: string): never => {
    throw new Error(`Extension "${extName}": ${why}`);
  };
  if (worker) refuse('jobs are not run for a worker-isolated extension yet');
  for (const { declared: j, input, run } of pairImplementations(
    'job',
    declared,
    implemented,
    refuse,
  )) {
    out.set(j.name, {
      name: j.name,
      input,
      reads: new Set(j.reads),
      writes: new Set(j.writes),
      retry: j.retry,
      run,
    });
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
  registered.set(extName, { jobs, system: capabilities.includes('data:system') });
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
  const boss = jobQueue();
  for (const job of reg.jobs.keys()) {
    const q = jobQueueName(extName, job);
    const entry = working.get(q);
    if (!entry) continue;
    working.delete(q);
    // A start still in flight sees it is no longer this registration's and adds
    // no worker; one already past that point is stopped here.
    await entry.ready.catch(() => undefined);
    if (boss) await boss.offWork(q).catch((err: Error) => warn(extName, err));
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
  const reg = registered.get(extName);
  const def = reg?.jobs.get(job);
  if (!reg || !def) return refuse(`${extName} declares no such job`);
  if (!reg.system) refuse('a job acts beyond its caller, which needs the data:system capability');
  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    refuse(`its input does not match the job's schema (${JSON.stringify(parsed.error.issues)})`);
  }
  const trx = p.trx;
  if (!trx) return refuse('this request holds no transaction');
  if (!p.tenantId) return refuse('this request runs in no tenant');
  const boss = jobQueue();
  if (!boss) return refuse('the job queue is not running');
  // Loaded a moment ago, its queue may still be being created.
  const queue = working.get(jobQueueName(extName, job));
  if (!queue) return refuse('its queue is not being worked');
  await queue.ready;
  const payload: JobPayload = {
    tenantId: p.tenantId,
    enqueuedBy: p.user.id,
    author: rowAuthorId(p.user),
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
    // Outside any tenant context (`work`), so the transaction's domain is this
    // tenant, not one inherited from wherever pg-boss resumed.
    await withTenantIsolation(tenantId, async (trx) => {
      await publishApiKeyActor(user.id, false, user.scopes);
      const collections = hostCollections(`job "${job}"`, def, jobData(user, trx, tenantId));
      await def.run(input, { collections });
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

/** The data API as the job's principal, in its transaction. */
function jobData(user: RequestUser, trx: Database, tenantId: string): DataIo {
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
