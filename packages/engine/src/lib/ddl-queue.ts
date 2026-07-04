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
import type { Database } from '../db/index.js';
import { DDLManager } from './ddl-manager.js';

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
  create_relation: 'ddl.create_relation',
  drop_relation: 'ddl.drop_relation',
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
      await _boss.createQueue(qname, QUEUE_RETENTION).catch(() => {
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
        .raw(`REINDEX INDEX CONCURRENTLY "${row.schemaname}"."${row.indexname}"`)
        .execute(db);
    } catch (err) {
      console.warn(`Failed to REINDEX invalid index ${row.indexname}:`, err);
    }
  }
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

async function waitForJobToSettle(queue: string, id: string, timeoutMs = 30_000): Promise<void> {
  if (!_boss) return;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await _boss.getJobById(queue, id).catch(() => null);
    if (!job) return;
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return;
    await Bun.sleep(50);
  }
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

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    retry_count: job.retrycount ?? 0,
    max_retries: job.retrylimit ?? DEFAULT_RETRY.retryLimit,
    created_at: new Date(job.createdon),
  };
}

// ── Per-type handlers ──────────────────────────────────────────────────────

async function registerHandlers(boss: PgBossInst, db: Database): Promise<void> {
  // CREATE COLLECTION runs OUTSIDE a transaction (CREATE INDEX
  // CONCURRENTLY is not allowed inside a tx block). DDLManager.createCollection
  // owns its own DDL sequencing.
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  await boss.work(QUEUE_NAMES.create_collection, async ([job]: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    await DDLManager.createCollection(db, job.data as any);
    // Apply tenant RLS to the new collection table immediately so it's isolated
    // without waiting for the next boot reconcile. Best-effort, non-fatal.
    try {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const name = (job.data as any)?.name;
      if (name) {
        const { applyTenantRLS } = await import('./tenant-manager.js');
        await applyTenantRLS(db, `zvd_${name}`);
      }
    } catch (err) {
      console.warn(
        '[ddl-queue] applyTenantRLS on create_collection failed:',
        (err as Error).message,
      );
    }
  });

  // The rest run inside a tx for atomicity (errors roll back partial DDL).
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  await boss.work(QUEUE_NAMES.drop_collection, async ([job]: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    await db.transaction().execute(async (trx: any) => {
      if (await skipForByod(trx, job.data, 'drop_collection')) return;
      const payload = job.data as { name: string; force?: boolean };
      await DDLManager.dropCollection(trx, payload.name, { force: payload.force === true });
    });
  });

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  await boss.work(QUEUE_NAMES.add_field, async ([job]: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    await db.transaction().execute(async (trx: any) => {
      if (await skipForByod(trx, job.data, 'add_field')) return;
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const payload = job.data as { collection: string; field: any };
      await DDLManager.addField(trx, payload.collection, payload.field);
    });
  });

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  await boss.work(QUEUE_NAMES.remove_field, async ([job]: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    await db.transaction().execute(async (trx: any) => {
      if (await skipForByod(trx, job.data, 'remove_field')) return;
      const payload = job.data as { collection: string; fieldName: string };
      await DDLManager.removeField(trx, payload.collection, payload.fieldName);
    });
  });

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  await boss.work(QUEUE_NAMES.create_relation, async ([job]: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    await db.transaction().execute(async (trx: any) => {
      await runCreateRelation(trx, job.data);
    });
  });

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  await boss.work(QUEUE_NAMES.drop_relation, async ([job]: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    await db.transaction().execute(async (trx: any) => {
      await runDropRelation(trx, job.data);
    });
  });
}

/** BYOD guard: extension-managed (is_managed=false) collections opt out of
 *  destructive DDL. Returns true if the job should be silently skipped. */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function skipForByod(trx: any, payload: any, _kind: string): Promise<boolean> {
  const collectionName: string | undefined = payload.collection ?? payload.name;
  if (!collectionName) return false;
  const meta = await trx
    .selectFrom('zvd_collections')
    .select('is_managed')
    .where('name', '=', collectionName)
    .executeTakeFirst()
    .catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  return Boolean(meta && (meta as any).is_managed === false);
}

const SAFE_NAME = /^[a-z][a-z0-9_]*$/;
const SAFE_ACTION = /^(CASCADE|SET NULL|RESTRICT|NO ACTION)$/;

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function runCreateRelation(trx: any, payload: any): Promise<void> {
  const relType: string = payload.type ?? 'm2o';
  const srcCol: string = payload.source_collection ?? '';
  const tgtCol: string = payload.target_collection ?? '';
  const srcField: string = payload.source_field ?? '';
  const tgtField: string = payload.target_field ?? 'id';
  const onDelete: string = payload.on_delete ?? 'SET NULL';
  const onUpdate: string = payload.on_update ?? 'NO ACTION';

  if (relType === 'm2o') {
    if (
      !SAFE_NAME.test(srcCol) ||
      !SAFE_NAME.test(tgtCol) ||
      !SAFE_NAME.test(srcField) ||
      !SAFE_NAME.test(tgtField)
    ) {
      throw new Error('Invalid identifier in create_relation payload');
    }
    if (!SAFE_ACTION.test(onDelete) || !SAFE_ACTION.test(onUpdate)) {
      throw new Error('Invalid ON DELETE/ON UPDATE action in create_relation');
    }
    await sql
      .raw(
        `ALTER TABLE zvd_${srcCol} ADD COLUMN IF NOT EXISTS "${srcField}" UUID REFERENCES zvd_${tgtCol}(${tgtField}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`,
      )
      .execute(trx);
  } else if (relType === 'm2m') {
    const junctionTable: string = payload.junction_table ?? '';
    if (
      junctionTable &&
      SAFE_NAME.test(junctionTable) &&
      SAFE_NAME.test(srcCol) &&
      SAFE_NAME.test(tgtCol)
    ) {
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS ${junctionTable} (` +
            `id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ` +
            `${srcCol}_id UUID REFERENCES zvd_${srcCol}(id) ON DELETE CASCADE, ` +
            `${tgtCol}_id UUID REFERENCES zvd_${tgtCol}(id) ON DELETE CASCADE, ` +
            `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
        )
        .execute(trx);
    }
  }
  // o2m / m2a handled on the other side.
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function runDropRelation(trx: any, payload: any): Promise<void> {
  const relType: string = payload.type ?? 'm2o';
  const srcCol: string = payload.source_collection ?? '';
  const srcField: string = payload.source_field ?? '';
  const junctionTable: string = payload.junction_table ?? '';

  if (relType === 'm2o' && SAFE_NAME.test(srcCol) && SAFE_NAME.test(srcField)) {
    await sql.raw(`ALTER TABLE zvd_${srcCol} DROP COLUMN IF EXISTS "${srcField}"`).execute(trx);
  } else if (relType === 'm2m' && junctionTable && SAFE_NAME.test(junctionTable)) {
    await sql.raw(`DROP TABLE IF EXISTS ${junctionTable} CASCADE`).execute(trx);
  }
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

// Internal helpers exposed for tests only.
export const _internalForTests = { mapJobToPublic, QUEUE_NAMES };
