/**
 * Single-instance mode: production without Valkey, on exactly one serving
 * process.
 *
 * Without Valkey the permission and identity caches live in each process, and
 * an invalidation — a revoked grant, a demoted god — reaches only the process
 * that made it. On one process that is correct. On two, the other one keeps
 * serving the old answer, for reads as much as for writes.
 *
 * So the mode is declared (`ZVELTIO_SINGLE_INSTANCE=1`, never inferred from a
 * missing `VALKEY_URL`, which is more often a mistake on a cluster), and the
 * instances check each other through Postgres: each writes a heartbeat to
 * `zv_instances`, and **the newest instance wins**. An instance that sees a
 * live heartbeat started after its own keeps serving for a grace period — the
 * load balancer's switch in a rolling or blue-green deploy — and then answers
 * 503 to everything but health, and closes its realtime connections so their
 * clients reconnect to the new one. It does not exit: an orchestrator would
 * restart it, it would become the newest, and the two would take turns.
 */

import type { MiddlewareHandler } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export const HEARTBEAT_MS = 10_000;
/** A heartbeat older than three beats belongs to an instance that is gone. */
const LIVE_SECONDS = (3 * HEARTBEAT_MS) / 1000;
/** How long a superseded instance keeps serving after it notices. */
export const GRACE_MS = 15_000;

export const RETIRED_REASON =
  'a newer instance runs without Valkey; set VALKEY_URL to run several replicas';

/** Declared, and only meaningful without Valkey: with it, replicas share invalidations. */
export function singleInstanceMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.ZVELTIO_SINGLE_INSTANCE === '1' && !env.VALKEY_URL;
}

/**
 * Write this instance's heartbeat and say whether a newer live instance exists.
 * Times are the database's, so hosts with drifting clocks agree. Rows of
 * instances gone for an hour are removed on the way.
 */
export async function beat(db: Database, instanceId: string): Promise<boolean> {
  const { rows } = await sql<{ newer: boolean }>`
    WITH gone AS (
      DELETE FROM zv_instances
       WHERE instance_id <> ${instanceId}::uuid
         AND last_seen < clock_timestamp() - interval '1 hour'
    ), me AS (
      INSERT INTO zv_instances (instance_id) VALUES (${instanceId}::uuid)
      ON CONFLICT (instance_id) DO UPDATE SET last_seen = clock_timestamp()
      RETURNING started_at
    )
    SELECT EXISTS (
      SELECT 1 FROM zv_instances o, me
       WHERE o.instance_id <> ${instanceId}::uuid
         AND o.last_seen > clock_timestamp() - make_interval(secs => ${LIVE_SECONDS})
         AND (o.started_at, o.instance_id) > (me.started_at, ${instanceId}::uuid)
    ) AS newer`.execute(db);
  return rows[0]?.newer === true;
}

export interface Heartbeat {
  /** True once the grace period after being superseded has passed. */
  retired(): boolean;
  stop(): void;
}

/**
 * Start beating. Call after the server listens: a heartbeat written before the
 * new instance can answer would retire the old one while nothing serves.
 */
export function startHeartbeat(
  db: Database,
  opts: { onRetire?: () => void; heartbeatMs?: number; graceMs?: number } = {},
): Heartbeat {
  const instanceId = crypto.randomUUID();
  let retired = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    try {
      if (!(await beat(db, instanceId)) || graceTimer) return;
    } catch (err) {
      // A database blip: the next beat retries. Our row ages meanwhile, which
      // only makes a newer instance ignore us — never the reverse.
      console.warn('[single-instance] heartbeat failed:', (err as Error).message);
      return;
    }
    clearInterval(interval);
    console.warn(
      `[single-instance] a newer instance started; draining for ${(opts.graceMs ?? GRACE_MS) / 1000}s`,
    );
    graceTimer = setTimeout(() => {
      retired = true;
      console.error(`❌ [single-instance] retired: ${RETIRED_REASON}`);
      opts.onRetire?.();
    }, opts.graceMs ?? GRACE_MS);
  };

  const interval = setInterval(tick, opts.heartbeatMs ?? HEARTBEAT_MS);
  void tick();
  return {
    retired: () => retired,
    stop: () => {
      clearInterval(interval);
      if (graceTimer) clearTimeout(graceTimer);
    },
  };
}

/** 503 for everything but health once `retired()` holds. */
export function refuseWhenRetired(retired: () => boolean): MiddlewareHandler {
  return async (c, next) => {
    const p = c.req.path;
    if (!retired() || p === '/api/health' || p === '/health') return next();
    return c.json({ error: 'instance_retired', message: RETIRED_REASON }, 503);
  };
}
