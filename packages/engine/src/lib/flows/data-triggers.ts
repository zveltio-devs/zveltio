import { sql } from 'kysely';
import { getDb, type Database } from '../../db/index.js';
import { type JobQueue, jobQueue, onJobQueueStart, principalRecord } from '../data/index.js';
import { toJsonb } from '../jsonb.js';
import {
  rolePrincipal,
  runOutsideTenantContext,
  runWithDomain,
  withTenantIsolation,
} from '../tenancy/index.js';
import { executeFlow } from './flow-executor.js';

/** The pg-boss queue every data-triggered flow run is a job on (ADR 0035). */
export const FLOW_QUEUE = 'flow.trigger';

/**
 * A completed trigger's job is kept one hour: its payload is a record snapshot,
 * and the run row already keeps what the flow was given. Created and retrying
 * jobs keep 30 days, as the webhook queue does.
 */
const FLOW_QUEUE_RETENTION = {
  deleteAfterSeconds: 60 * 60,
  retentionSeconds: 30 * 24 * 60 * 60,
};

type DataEvent = 'insert' | 'update' | 'delete';

/** One trigger job's payload: the write's event, before the flow's role reads it. */
export interface FlowJob {
  tenantId: string;
  flowId: string;
  eventId: string;
  sequence: number;
  event: DataEvent;
  collection: string;
  /** The outbound record (no unserved, no sealed columns). */
  data: Record<string, unknown>;
  timestamp: string;
}

const TRIGGER_TYPE: Record<DataEvent, string> = {
  insert: 'on_create',
  update: 'on_update',
  delete: 'on_delete',
};

// Created once per pg-boss instance, before the first send or work on it.
const queues = new WeakMap<JobQueue, Promise<void>>();
export function ensureFlowQueue(boss: JobQueue): Promise<void> {
  let ready = queues.get(boss);
  if (!ready) {
    ready = boss.createQueue(FLOW_QUEUE, FLOW_QUEUE_RETENTION).then(() => undefined);
    ready.catch(() => queues.delete(boss));
    queues.set(boss, ready);
  }
  return ready;
}

/**
 * The tenant's active flows triggered by `event` on `collection`, read on the
 * write's own transaction (ADR 0035 decision 2): a flow receives the writes
 * whose transaction could see it.
 *
 * A `trigger_config` stored as a JSON string scalar (a driver that bound the
 * text, not the object) is unwrapped, as `runFlowJob` and the old in-process
 * trigger read it: such a flow fired before and must keep firing.
 */
export async function triggeredFlows(
  trx: Database,
  tenant: string,
  event: string,
  collection: string,
): Promise<string[]> {
  const type = TRIGGER_TYPE[event as DataEvent];
  if (!type) return [];
  const { rows } = await sql<{ id: string }>`
    SELECT id::text AS id FROM zv_flows
     WHERE is_active = true
       AND tenant_id = ${tenant}::uuid
       AND trigger_type = ${type}
       AND (CASE WHEN jsonb_typeof(trigger_config) = 'string'
                 THEN (trigger_config #>> '{}')::jsonb
                 ELSE trigger_config END)->>'collection' = ${collection}`.execute(trx);
  return rows.map((r) => r.id);
}

/**
 * Run one trigger (ADR 0035 decision 6). The run row is keyed by the flow and
 * the event, so a job delivered again executes nothing: flow steps send mail and
 * call HTTP. A run it finds still `running` died with its process and is marked
 * `failed` / `interrupted` so the operator sees it.
 *
 * The flow is read again as its firm: deleted, inactive or no longer triggered
 * by this event, it runs nothing. The record is what its role reads (ADR 0004);
 * a record that role may not read runs nothing, as a realtime subscriber is not
 * told of a row it cannot see. With no role (deleted) the run is refused by
 * `executeFlow`, and says so. A throw before the run row exists is retried by
 * pg-boss; after it, the outcome is the run row's.
 */
export async function runFlowJob(job: { data: FlowJob }, db: Database = getDb()): Promise<void> {
  const d = job.data;
  const prior = await sql<{ status: string }>`
    SELECT status FROM zv_flow_runs WHERE flow_id = ${d.flowId} AND event_id = ${d.eventId}
  `.execute(db);
  if (prior.rows[0]) {
    if (prior.rows[0].status === 'running') {
      await sql`
        UPDATE zv_flow_runs SET status = 'failed', error = 'interrupted', finished_at = NOW()
         WHERE flow_id = ${d.flowId} AND event_id = ${d.eventId} AND status = 'running'
      `.execute(db);
    }
    return;
  }

  const flow = await withTenantIsolation(d.tenantId, (trx) =>
    trx
      .selectFrom('zv_flows')
      .select(['is_active', 'trigger_type', 'trigger_config', 'run_as_role'])
      .where('id', '=', d.flowId)
      .where('tenant_id', '=', d.tenantId)
      .executeTakeFirst(),
  );
  const cfg = (
    typeof flow?.trigger_config === 'string'
      ? JSON.parse(flow.trigger_config)
      : (flow?.trigger_config ?? {})
  ) as { collection?: string };
  if (
    !flow?.is_active ||
    flow.trigger_type !== TRIGGER_TYPE[d.event] ||
    cfg.collection !== d.collection
  ) {
    return;
  }

  const trigger: Record<string, unknown> = { collection: d.collection, event: d.event };
  const role = flow.run_as_role;
  if (role) {
    const seen = await principalRecord(
      db,
      d.collection,
      await runWithDomain(d.tenantId, () => rolePrincipal(role)),
      d.data,
    );
    if (seen === null) return;
    trigger.record = seen;
  }

  const claimed = await sql<{ id: string }>`
    INSERT INTO zv_flow_runs (flow_id, status, trigger_data, event_id)
    VALUES (${d.flowId}, 'running', ${toJsonb(trigger)}, ${d.eventId})
    ON CONFLICT (flow_id, event_id) DO NOTHING
    RETURNING id::text AS id
  `.execute(db);
  // Another delivery of this job claimed it first.
  if (!claimed.rows[0]) return;
  await executeFlow(db, d.flowId, trigger, claimed.rows[0].id);
}

/** Work the trigger queue on this instance. Boot only; tests run jobs with `_runFlowJobs`. */
export function startFlowTriggerWorker(): void {
  onJobQueueStart(async (boss) => {
    await ensureFlowQueue(boss);
    const options = {
      localConcurrency: 5,
      pollingIntervalSeconds: 1,
      burstWhenReadyExceeds: 5,
    } as const;
    await boss.work<FlowJob, void, typeof options>(FLOW_QUEUE, options, ([j]) =>
      runOutsideTenantContext(() => runFlowJob(j!)),
    );
  });
}

/**
 * Test-only: claim every due trigger job and run it as the worker would, until
 * none is due, on `db` (the engine's pool unless a test gives another).
 */
export async function _runFlowJobs(db?: Database): Promise<number> {
  const boss = jobQueue();
  if (!boss) return 0;
  await ensureFlowQueue(boss);
  let ran = 0;
  for (;;) {
    const jobs = await boss.fetch<FlowJob>(FLOW_QUEUE, { batchSize: 50 });
    if (jobs.length === 0) return ran;
    for (const j of jobs) {
      ran++;
      await runOutsideTenantContext(() => runFlowJob(j, db)).then(
        () => boss.complete(FLOW_QUEUE, j.id),
        (err: Error) => boss.fail(FLOW_QUEUE, j.id, { message: err.message }),
      );
    }
  }
}
