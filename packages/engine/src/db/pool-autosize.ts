/**
 * How big should the pool be on THIS server?
 *
 * `DB_POOL_MAX` is a flat default, and a flat default is wrong twice: it wastes
 * a machine with 512 GB of RAM and it overcommits one with 8 GB. The obvious fix
 * is to measure the host and scale — but the host running the engine is not the
 * constraint, and measuring it would answer the wrong question with confidence.
 *
 * ── What actually limits this number ──────────────────────────
 *
 * A pooled connection is a backend process on the DATABASE server. What bounds
 * it is that server's `max_connections`, which is a setting an operator chose,
 * not free memory the engine can sense. A database tuned to 100 connections
 * will refuse the 101st however much RAM is idle, and a database on a huge box
 * still hands out only what it was configured to hand out.
 *
 * So the engine asks the database, once, at boot — the same source
 * `startup-guards.ts` already prints its advice from.
 *
 * ── The one thing an instance cannot know ─────────────────────
 *
 * How many siblings share that database. Every replica auto-sizing to "what
 * fits" collectively exhausts the server, and it fails at the worst moment:
 * under the load that started the extra replicas. Nothing an instance can
 * observe fixes this — counting current connections is a race at boot, when
 * replicas start together.
 *
 * So that number is declared (`ZVELTIO_INSTANCES`, default 1) and everything
 * else is derived. A declaration that is wrong is at least visible; a guess
 * that is wrong looks like a database outage.
 *
 * ── Deliberately conservative ─────────────────────────────────
 *
 * The engine takes at most `DB_POOL_SHARE` (default half) of what remains after
 * the server's own reserve, because the database is rarely the engine's alone:
 * migrations, backups, a psql session, another application. Half of a 200
 * connection server is 90-something per instance, which is far above anything
 * measured as useful — so the result is also clamped to `MAX_AUTO`. Autosizing
 * is meant to stop an 8 GB box from promising 40, not to let a big one promise
 * 200.
 */

import { SQL } from 'bun';

/** Never size below this: a handful of connections is needed to serve at all. */
const MIN_AUTO = 10;
/**
 * Never size above this without an explicit `DB_POOL_MAX`.
 *
 * Above roughly this many concurrent transactions, Postgres itself is the
 * bottleneck rather than the pool, and a bigger number mostly buys a longer
 * queue inside the database instead of a shorter one outside it.
 */
const MAX_AUTO = 60;

export interface PoolSizing {
  /** The number to use. */
  max: number;
  /** How it was arrived at, for the boot log. */
  reason: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Ask the database what it allows, and derive a pool size from it.
 *
 * Returns `null` when the question cannot be asked — the caller then keeps the
 * flat default. A boot must not fail because sizing advice was unavailable.
 */
export async function autosizePool(connectionString: string): Promise<PoolSizing | null> {
  // One short-lived connection, before the pool exists. The alternative is to
  // build a pool to find out how big the pool should be.
  const probe = new SQL({ url: connectionString, max: 1 });
  try {
    const rows = (await probe`
      SELECT
        current_setting('max_connections')::int              AS max_connections,
        current_setting('superuser_reserved_connections')::int AS reserved
    `) as Array<{ max_connections: number; reserved: number }>;
    const row = rows[0];
    if (!row) return null;

    const instances = intFromEnv('ZVELTIO_INSTANCES', 1);
    const share = Number(process.env.DB_POOL_SHARE ?? '0.5');
    const fraction = Number.isFinite(share) && share > 0 && share <= 1 ? share : 0.5;

    const usable = Math.max(0, row.max_connections - row.reserved);
    const budget = Math.floor((usable * fraction) / instances);
    const max = Math.min(MAX_AUTO, Math.max(MIN_AUTO, budget));

    const reason =
      `server max_connections=${row.max_connections} (reserved ${row.reserved}), ` +
      `share ${fraction}, instances ${instances} → ${budget}, clamped to ${max}`;
    return { max, reason };
  } catch {
    // Unreadable settings, no permission, an older server: not a reason to
    // refuse to start.
    return null;
  } finally {
    await probe.end().catch(() => {});
  }
}
