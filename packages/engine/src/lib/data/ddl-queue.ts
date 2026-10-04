/**
 * DDL Queue — pg-boss-backed job queue for DDL operations.
 *
 * Previously this file hosted a hand-rolled `zv_ddl_jobs` table + polling
 * loop + retry/requeue passes (~324 lines). pg-boss replaces all of that
 * machinery with: persistent jobs, SKIP-LOCKED claims, exponential backoff
 * retries, DLQ for exhausted retries, dead-job archive, observability
 * tooling — all backed by Postgres so no new infrastructure.
 *
 * Public surface preserved (callers don't change):
 *   - `initDDLQueue(db)` — boots pg-boss, registers handlers.
 *   - `enqueueDDLJob(db, type, payload)` — returns a jobId string.
 *   - `getDDLJob(db, jobId)` — returns `{ id, type, payload, status, ... }`
 *     in the same shape Studio + tests expect.
 *
 * Behind the scenes:
 *   - pg-boss creates its own schema (`pgboss.*`) on first start via its
 *     bundled migrator. We let it run idempotently.
 *   - Each DDL type is a separate queue name (`ddl.create_collection` etc.)
 *     so retries / DLQ are scoped per operation.
 *   - The old `zv_ddl_jobs` table is preserved for historical queries but
 *     no longer receives new rows. A future migration can drop it.
 *
 * Why per-type queues instead of one queue + switch:
 *   - pg-boss's worker pool sizing is per queue. CREATE COLLECTION should
 *     run serially (lock contention) but ADD FIELD can fan out. Keeping
 *     them separate lets us tune concurrency without code changes.
 */

import { sql } from 'kysely';
import { PgBoss } from 'pg-boss';
import type { Database } from '../../db/index.js';
import { DDLManager } from './ddl-manager.js';
import { type FieldConfig, fieldTypeRegistry } from './field-type-registry.js';
import { GhostDDL } from './ghost-ddl.js';
import { broadcastSchemaChange, type SchemaChangeAction } from '../../routes/ws.js';
import { realtimeBus, SCHEMA_CHANGED_EVENT } from '../runtime/index.js';
import { onAfterCommit } from '../tenancy/index.js';

// pg-boss 12+ is ESM-only and exposes `PgBoss` as a NAMED export (not
// default). Prior versions had a default export; the previous unwrap
// (`PgBossMod.default ?? PgBossMod`) broke on Bun 1.3.14 where the
// fallback resolved to a non-constructible namespace object.
type PgBossInst = InstanceType<typeof PgBoss>;

let _db: Database;
let _boss: PgBossInst | null = null;

/** Map our public type names to pg-boss queue names. Kept identical for grep-ability. */
const QUEUE_NAMES = {
  create_collection: 'ddl.create_collection',
  drop_collection: 'ddl.drop_collection',
  add_field: 'ddl.add_field',
  remove_field: 'ddl.remove_field',
  build_index: 'ddl.build_index',
} as const;
type DdlJobType = keyof typeof QUEUE_NAMES;

interface PublicJobShape {
  id: string;
  type: DdlJobType;
  payload: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dlq';
  started_at: Date | null;
  completed_at: Date | null;
  error: string | null;
  retry_count: number;
  max_retries: number;
  created_at: Date;
}

const DEFAULT_RETRY = {
  retryLimit: 3,
  retryDelay: 5, // seconds — initial backoff
  retryBackoff: true, // exponential
} as const;

/**
 * Boot pg-boss against the existing Postgres connection. Creates the
 * `pgboss.*` schema on first run, then registers per-queue handlers
 * that dispatch into DDLManager.
 *
 * Failure is non-fatal at startup: we warn and continue without queue
 * functionality. Enqueue calls will throw with a clear message until the
 * queue is operational.
 */
export async function initDDLQueue(db: Database): Promise<void> {
  _db = db;

  // pg-boss needs its own connection string. Derive from DATABASE_URL.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('[ddl-queue] DATABASE_URL not set — pg-boss not started; DDL enqueues will fail');
    return;
  }

  try {
    // pg-boss 12 removed the top-level `archiveCompletedAfterSeconds` /
    // `retentionDays` constructor options that pg-boss 10 accepted. Job
    // retention is now configured per-queue via `createQueue({ retentionDays })`
    // — applied below — and supervise runs maintenance automatically.
    _boss = new PgBoss({
      connectionString,
    });
    _boss.on('error', (err: Error) => {
      console.warn('[ddl-queue] pg-boss error:', err.message);
    });
    await _boss.start();

    // Per-queue retention matching the pg-boss 10 defaults we relied on:
    //   - Completed jobs auto-delete after 7 days (was archiveCompletedAfterSeconds).
    //   - Created/retry jobs auto-delete after 30 days (was retentionDays).
    const QUEUE_RETENTION = {
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      retentionSeconds: 30 * 24 * 60 * 60,
    };
    for (const qname of Object.values(QUEUE_NAMES)) {
      // One active build per index (its name is the singletonKey), on any replica.
      const policy = qname === QUEUE_NAMES.build_index ? { policy: 'singleton' } : {};
      await _boss.createQueue(qname, { ...QUEUE_RETENTION, ...policy }).catch(() => {
        /* already exists */
      });
    }

    // One-time recovery: reindex any CREATE INDEX CONCURRENTLY that left an
    // INVALID index behind (process crash during a previous run). Carried
    // over from the legacy poller because this is a Postgres-level concern,
    // not a queue concern.
    await reindexInvalid(db).catch(() => {});

    await registerHandlers(_boss, db);
    console.log('✅ DDL queue (pg-boss) started');
  } catch (err) {
    console.warn('[ddl-queue] failed to start pg-boss:', (err as Error).message);
    _boss = null;
  }
}

async function reindexInvalid(db: Database): Promise<void> {
  const rows = await sql<{ schemaname: string; indexname: string }>`
    SELECT s.schemaname, s.indexrelname AS indexname
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON i.indexrelid = s.indexrelid
    WHERE i.indisvalid = false
      AND s.schemaname = 'public'
      AND (s.relname LIKE 'zvd_%' OR s.relname LIKE 'zv_%')
  `.execute(db);
  for (const row of rows.rows) {
    try {
      await sql
        // raw-ident-ok: both names come back from the `pg_index` / `pg_stat` query
        // above, filtered to schema `public` and `zv%` — they are identifiers
        // PostgreSQL itself is reporting, not names any caller supplied.
        .raw(`REINDEX INDEX CONCURRENTLY "${row.schemaname}"."${row.indexname}"`)
        .execute(db);
    } catch (err) {
      console.warn(`Failed to REINDEX invalid index ${row.indexname}:`, err);
    }
  }
}

/**
 * Tell the schema watchers (`SCHEMA_CHANNEL` in `routes/ws.ts`) that a
 * collection was created, altered or dropped — on this instance and, through
 * the realtime bus, on every other. Once the change is committed: from inside a
 * request transaction it waits for the commit, and a rollback drops it. No
 * tenant: collections are instance-wide.
 */
export function announceSchemaChange(collection: string, action: SchemaChangeAction): void {
  onAfterCommit(() => {
    broadcastSchemaChange(collection, action);
    return realtimeBus().publish({
      event: SCHEMA_CHANGED_EVENT,
      collection,
      data: { action },
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Enqueue a DDL job. Returns the pg-boss job id (a uuid string).
 *
 * @param db       Engine DB (unused — pg-boss has its own pool; the param
 *                 is kept for back-compat with the old signature so call
 *                 sites don't change).
 * @param type     One of the DdlJobType keys.
 * @param payload  Job-specific payload — see processJob handlers.
 */
export async function enqueueDDLJob(
  _unusedDb: Database,
  type: DdlJobType | string,
  payload: unknown,
): Promise<string> {
  if (!_boss) throw new Error('DDL queue not initialized — call initDDLQueue() first');
  const queue = (QUEUE_NAMES as Record<string, string>)[type];
  if (!queue) throw new Error(`Unknown DDL job type: ${type}`);

  const jobId = await _boss.send(queue, payload as object, {
    retryLimit: DEFAULT_RETRY.retryLimit,
    retryDelay: DEFAULT_RETRY.retryDelay,
    retryBackoff: DEFAULT_RETRY.retryBackoff,
  });
  if (!jobId) throw new Error(`Failed to enqueue ${type}: pg-boss returned no id`);

  // In test mode, the integration suite expects the job to be processed
  // synchronously after enqueue. pg-boss's worker is async; emulate by
  // polling until the job leaves the active state. Bounded to avoid hangs.
  if (process.env.NODE_ENV === 'test') {
    await waitForJobToSettle(queue, jobId);
  }

  return jobId;
}

/** An index build `deferIndexBuilds` held back; the only DDL a build_index job runs. */
const INDEX_BUILD =
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"?([a-z0-9_]+)"?\s+ON\s+"?zvd_[a-z0-9_]+"?[\s(][^;]*$/i;

/**
 * Hand the CONCURRENTLY builds an extension's schema change deferred to the DDL
 * queue, durably and now: the column they index is already committed, so a
 * crash or a rolled-back request must not leave it unindexed. Without a queue
 * they run after the commit, as they did before.
 */
export async function enqueueIndexBuilds(db: Database, indexes: string[]): Promise<void> {
  for (const ddl of indexes) {
    const name = INDEX_BUILD.exec(ddl)?.[1];
    try {
      if (!_boss || !name) throw new Error('DDL queue not running');
      await _boss.send(QUEUE_NAMES.build_index, { ddl }, { ...DEFAULT_RETRY, singletonKey: name });
    } catch (err) {
      console.warn(`[ddl-queue] index build not queued, running after commit (${ddl}):`, err);
      onAfterCommit(() =>
        buildIndexJob(db, { ddl }).catch((e) =>
          console.warn(`[ddl-queue] index build failed (${ddl}):`, (e as Error).message),
        ),
      );
    }
  }
}

/**
 * Build one deferred index, idempotently: a valid index of that name is done;
 * an INVALID one — left by a build that was killed, failed or deadlocked — is
 * dropped and built again, because `IF NOT EXISTS` would keep it unusable.
 */
async function buildIndexJob(db: Database, job: { ddl: string }) {
  const name = INDEX_BUILD.exec(job.ddl)?.[1];
  if (!name) throw new Error(`[ddl-queue] build_index refused a statement: ${job.ddl}`);
  const index = sql`to_regclass(format('public.%I', ${name}::text))`;
  const state = await sql<{ valid: boolean; building: boolean }>`
    SELECT indisvalid AS valid,
           EXISTS (SELECT 1 FROM pg_stat_progress_create_index p
                    WHERE p.index_relid = indexrelid) AS building
      FROM pg_index WHERE indexrelid = ${index}`.execute(db);
  const found = state.rows[0];
  if (found?.valid) return;
  // Another build of it is still running (a retry after expiry): not ours to drop.
  if (found?.building) throw new Error(`[ddl-queue] index ${name} is still being built`);
  // raw-ident-ok: `name` matched INDEX_BUILD's [a-z0-9_]+.
  if (found) await sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`).execute(db);
  try {
    await sql.raw(job.ddl).execute(db);
  } catch (err) {
    // The table or column went away since: nothing left to index, not a retry.
    if (['42P01', '42703'].includes(String((err as { errno?: unknown }).errno))) return;
    throw err;
  }
}

async function waitForJobToSettle(queue: string, id: string, timeoutMs = 30_000): Promise<void> {
  if (!_boss) return;
  const start = Date.now();
  let state = 'unknown';
  while (Date.now() - start < timeoutMs) {
    const job = await _boss.getJobById(queue, id).catch(() => null);
    if (!job) return;
    state = job.state;
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return;
    await Bun.sleep(50);
  }
  // It used to return here as if the job had run, and the caller answered 202
  // over a table that did not exist yet. Say so, with what the database was
  // doing, so a stall in CI names its cause instead of a 30 s timeout.
  throw new Error(
    `[ddl-queue] ${queue} job ${id} still ${state} after ${timeoutMs} ms; ` +
      `backends: ${await describeBackends()}`,
  );
}

/** Every busy or blocked backend of this database, for a stall report. Bounded. */
async function describeBackends(): Promise<string> {
  const q = sql<Record<string, unknown>>`
    SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
           round(extract(epoch FROM now() - xact_start)) AS xact_s, left(query, 160) AS query
      FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
  `
    .execute(_db)
    .then((r) => JSON.stringify(r.rows));
  return Promise.race([q, Bun.sleep(5000).then(() => 'unavailable (query hung)')]).catch(
    (err) => `unavailable (${(err as Error).message})`,
  );
}

/**
 * Read a job's current state. Returns the shape Studio's polling code
 * expects, derived from pg-boss's internal columns.
 */
export async function getDDLJob(
  _unusedDb: Database,
  jobId: string,
): Promise<PublicJobShape | null> {
  if (!_boss) return null;
  // We don't know which queue the job belongs to from the id alone, so we
  // try each. pg-boss returns `null` for misses; first hit wins.
  for (const [type, queue] of Object.entries(QUEUE_NAMES)) {
    const job = await _boss.getJobById(queue, jobId).catch(() => null);
    if (job) return mapJobToPublic(job, type as DdlJobType);
  }
  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
function mapJobToPublic(job: any, type: DdlJobType): PublicJobShape {
  const stateMap: Record<string, PublicJobShape['status']> = {
    created: 'pending',
    retry: 'pending',
    active: 'running',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'failed',
    expired: 'failed',
  };
  return {
    id: job.id,
    type,
    payload: job.data,
    status: stateMap[job.state] ?? 'pending',
    started_at: job.startedOn ? new Date(job.startedOn) : null,
    completed_at: job.completedOn ? new Date(job.completedOn) : null,
    error: job.output?.message ?? (typeof job.output === 'string' ? job.output : null),
    // camelCase, because that is what pg-boss returns. Its SELECT aliases every
    // snake_case column — `retry_count as "retryCount"`, `retry_limit as
    // "retryLimit"`, `created_on as "createdOn"` (plans.js:298-309 in the
    // installed 12.18.2). Reading `job.retrycount` therefore always found
    // `undefined`:
    //
    //   retry_count  always 0                — a job that had retried four times
    //                                          reported none, so the retry
    //                                          mechanism looked idle while working
    //   max_retries  always the local default — not the queue's actual limit
    //   created_at   `new Date(undefined)`   — Invalid Date, serialised as null
    //
    // The neighbouring `startedOn` / `completedOn` reads on the two lines above
    // were already correct, which is what makes this easy to miss on a read: the
    // block looks consistent and three of six fields are wrong.
    retry_count: job.retryCount ?? 0,
    max_retries: job.retryLimit ?? DEFAULT_RETRY.retryLimit,
    created_at: job.createdOn ? new Date(job.createdOn) : new Date(0),
  };
}

// ── Run now ───────────────────────────────────────────────────────────────────

/**
 * Create a collection on the pool, now: the table, its tenant RLS, the schema
 * announcement. The create_collection job runs this, and so does
 * `POST /api/admin/schema/apply`, which must see the table before its next step.
 */
export async function runCreateCollection(
  db: Database,
  definition: Parameters<typeof DDLManager.createCollection>[1],
): Promise<void> {
  await DDLManager.createCollection(db, definition);
  const name = definition.name;
  // Apply tenant RLS to the new collection table immediately so it's isolated
  // without waiting for the next boot reconcile. Best-effort, non-fatal.
  try {
    const { applyTenantRLS } = await import('../tenancy/index.js');
    await applyTenantRLS(db, `zvd_${name}`);
  } catch (err) {
    console.warn('[ddl-queue] applyTenantRLS on create_collection failed:', (err as Error).message);
  }
  announceSchemaChange(name, 'create');
}

/**
 * The row count of `tableName`, or `Infinity` when it cannot be read.
 *
 * A swallowed count error once took the locking path on a table whose size
 * was unknown; on a large table that is a production outage. `Infinity` is the
 * safe answer: an unknown size is treated as large, so the online path is
 * taken. Being wrong that way costs a slower migration; the other way, downtime.
 */
export async function rowCountOrAssumeLarge(db: Database, tableName: string): Promise<number> {
  try {
    const result = await sql<{ cnt: string }>`
      SELECT count(*) AS cnt FROM ${sql.id(tableName)}
    `.execute(db);
    return Number(result.rows[0]?.cnt ?? 0);
  } catch (err) {
    console.warn(
      `[ddl-queue] could not count rows in ${tableName}; assuming it is large and ` +
        `using the online (Ghost DDL) path. Cause: ${err instanceof Error ? err.message : err}`,
    );
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Add a field on the pool, now. Over 100k rows the column and its per-tenant
 * key are built on a Ghost DDL copy; `addField` then finds both in place and
 * does what is left — indexes and the field in `zvd_collections.fields`. The
 * schema-branch merge and `POST /api/admin/schema/apply` run this.
 */
export async function runAddField(
  db: Database,
  collection: string,
  field: Parameters<typeof DDLManager.addField>[2],
): Promise<void> {
  const tableName = DDLManager.getTableName(collection);
  if (
    fieldTypeRegistry.getColumnDDL(field as FieldConfig) &&
    (await rowCountOrAssumeLarge(db, tableName)) > 100_000
  ) {
    await GhostDDL.execute(
      db,
      tableName,
      [{ kind: 'add_column', field: field as FieldConfig }],
      (phase, detail) => console.log(`[ghost-ddl] ${phase}: ${detail}`),
    );
  }
  await DDLManager.addField(db, collection, field);
  announceSchemaChange(collection, 'alter');
}

// ── Per-type handlers ──────────────────────────────────────────────────────

async function registerHandlers(boss: PgBossInst, db: Database): Promise<void> {
  // CREATE COLLECTION runs OUTSIDE a transaction (CREATE INDEX
  // CONCURRENTLY is not allowed inside a tx block). DDLManager.createCollection
  // owns its own DDL sequencing.
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  await boss.work(QUEUE_NAMES.create_collection, async ([job]: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    await runCreateCollection(db, job.data as any);
  });

  // The rest run inside a tx for atomicity (errors roll back partial DDL).
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  await boss.work(QUEUE_NAMES.drop_collection, async ([job]: any[]) => {
    const payload = job.data as { name: string; force?: boolean };
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const ran = await db.transaction().execute(async (trx: any) => {
      if (await skipForByod(trx, job.data, 'drop_collection')) return false;
      await DDLManager.dropCollection(trx, payload.name, { force: payload.force === true });
      return true;
    });
    if (ran) announceSchemaChange(payload.name, 'drop');
  });

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  await boss.work(QUEUE_NAMES.add_field, async ([job]: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const payload = job.data as { collection: string; field: any };
    // On the pool, like create_collection: addField builds the field's indexes
    // CONCURRENTLY, which Postgres refuses inside a transaction block. Handed a
    // transaction, every indexed field failed with 25001 and pg-boss retried
    // the same failure until it gave up; the column never appeared.
    if (await skipForByod(db, job.data, 'add_field')) return;
    await DDLManager.addField(db, payload.collection, payload.field);
    announceSchemaChange(payload.collection, 'alter');
  });

  await boss.work<{ ddl: string }>(QUEUE_NAMES.build_index, ([job]) =>
    buildIndexJob(db, job!.data),
  );

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  await boss.work(QUEUE_NAMES.remove_field, async ([job]: any[]) => {
    const payload = job.data as { collection: string; fieldName: string };
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const ran = await db.transaction().execute(async (trx: any) => {
      if (await skipForByod(trx, job.data, 'remove_field')) return false;
      await DDLManager.removeField(trx, payload.collection, payload.fieldName);
      return true;
    });
    if (ran) announceSchemaChange(payload.collection, 'alter');
  });
}

/** BYOD guard: extension-managed (is_managed=false) collections opt out of
 *  destructive DDL. Returns true if the job should be silently skipped. */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
async function skipForByod(trx: any, payload: any, _kind: string): Promise<boolean> {
  const collectionName: string | undefined = payload.collection ?? payload.name;
  if (!collectionName) return false;

  // A failed lookup means SKIP, not proceed.
  //
  // This read used to end `.catch(() => null)`, and `Boolean(null && …)` is
  // false — which this function's contract defines as "go ahead". So a transient
  // database error while asking "am I allowed to alter this table?" answered
  // yes, and the callers are `drop_collection`, `remove_field` and `add_field`:
  // the engine would drop a column, or a whole table, that an operator had
  // explicitly marked as not ours to manage (is_managed = false, a BYOD table
  // holding their own data).
  //
  // Unknown ownership is the one case where doing nothing is always recoverable
  // and doing something may not be.
  let meta: { is_managed: boolean | null } | undefined;
  try {
    meta = await trx
      .selectFrom('zvd_collections')
      .select('is_managed')
      .where('name', '=', collectionName)
      .executeTakeFirst();
  } catch (err) {
    console.error(
      `[ddl-queue] could not read is_managed for "${collectionName}", so it is unknown ` +
        `whether this collection is ours to alter. Skipping the ${_kind} job rather than ` +
        `running destructive DDL on a table that may not be managed. Cause:`,
      err instanceof Error ? err.message : err,
    );
    return true;
  }

  return meta?.is_managed === false;
}

/** Whether the pg-boss DDL queue worker is started (health probe, H-1.4). */
export function isDDLQueueStarted(): boolean {
  return _boss !== null;
}

/** Stop pg-boss gracefully. Call from process shutdown. */
export async function stopDDLQueue(): Promise<void> {
  if (_boss) {
    try {
      await _boss.stop({ graceful: true });
    } catch {
      /* */
    }
    _boss = null;
  }
}

/**
 * Swap the module's pg-boss handle and return what was there. Test-only.
 *
 * The guards below (`isDDLQueueStarted`, `enqueueDDLJob`, `getDDLJob`) answer
 * from module state, and `bun test` runs every file in ONE process — so a
 * harness file that boots the app starts the queue for everybody, and the tests
 * that pin "what happens when the queue is not running" then measure a running
 * queue instead. They did: `enqueueDDLJob` really enqueued and the case sat
 * there until its 30s deadline.
 *
 * Stopping the queue would fix those three by breaking whatever file boots next,
 * so this hands a test the handle instead: set null, assert, put the old one
 * back.
 */
export function _setBossForTests(boss: unknown): unknown {
  const previous = _boss;
  _boss = boss as PgBossInst | null;
  return previous;
}

// Internal helpers exposed for tests only.
export const _internalForTests = {
  mapJobToPublic,
  QUEUE_NAMES,
  skipForByod,
  reindexInvalid,
};
