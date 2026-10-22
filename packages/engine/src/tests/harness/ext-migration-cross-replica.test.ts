/**
 * An extension migration on ONE replica leaves no stale plan on the OTHERS.
 *
 * #1253 made the replica that runs an extension migration recycle its own pool,
 * because `ai`'s migration adds columns to `zvd_collections` and every pooled
 * connection that prepared `DDLManager.getCollection`'s `select * from
 * "zvd_collections" where "name" = $1` then fails it with `0A000 cached plan
 * must not change result type` — a 500 inside a request transaction. Every
 * other engine on the same database never learned the migration ran, and kept
 * failing that way until it restarted.
 *
 * Two real replicas: this process is B (the harness app, its pool, a realtime
 * bus listening as boot starts it), and A is a second `bun` process with its own
 * pool and bus that runs the migration the way the enable route does. A's local
 * recycle cannot reach B's pool, so only the announcement can.
 *
 * On Valkey, the bus every multi-replica deployment runs (production refuses to
 * boot without it unless ZVELTIO_SINGLE_INSTANCE=1). Runs only when
 * HARNESS_VALKEY_URL names a reachable Valkey (the CI step "Auth on Valkey",
 * which fails on a skip, provides one); skipped otherwise.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { getActiveBunPool } from '../../db/bun-sql-dialect.js';
import type { Database } from '../../db/index.js';
import { databaseDriver } from '../../db/pg-dialect.js';
import {
  dispatchToWs,
  ORIGIN_ID,
  POOL_RECYCLE_EVENT,
  ValkeyRealtimeBus,
} from '../../lib/runtime/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const VALKEY = process.env.HARNESS_VALKEY_URL;
// `pg` sends unnamed statements: no plan to go stale (see stale-plan-recycle).
const onBun = harnessAvailable() && databaseDriver() === 'bun';
const d = onBun && VALKEY ? describe : describe.skip;

const EXT = 'extxreplica';
const COL = 'zz_xreplica_probe';
const DIR = `${process.env.TMPDIR ?? '/tmp'}/zv-extxreplica-${Date.now()}`;
const POOL = Number(process.env.DB_POOL_MAX ?? 10);
const src = (p: string) => new URL(p, import.meta.url).pathname;

/** Replica A: its own pool and bus, wired as `index.ts` boots them, then `op`. */
async function onReplicaA(op: 'migrate' | 'purge'): Promise<void> {
  const script = `
    const { initDatabase } = await import(${JSON.stringify(src('../../db/index.js'))});
    const { realtimeBus } = await import(${JSON.stringify(src('../../lib/runtime/index.js'))});
    const { withExtensionLock } = await import(${JSON.stringify(src('../../lib/extensions/extension-utils.js'))});
    const m = await import(${JSON.stringify(src('../../lib/extensions/migration-runner.js'))});
    const db = await initDatabase();
    await realtimeBus().start();
    const ext = { name: ${JSON.stringify(EXT)}, getMigrations: () => [${JSON.stringify(`${DIR}/001_probe.sql`)}] };
    await withExtensionLock(db, ext.name, () =>
      ${op === 'migrate' ? 'm.runExtensionMigrations(ext, db)' : 'm.purgeExtensionData(ext.name, db)'});
    await Bun.sleep(200);
    process.exit(0);
  `;
  const proc = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, VALKEY_URL: VALKEY },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`replica A failed: ${await new Response(proc.stderr).text()}`);
}

d('extension migrations on another replica: no pooled plan outlives them here', () => {
  let db: Database;
  let DDLManager: typeof import('../../lib/data/ddl-manager.js').DDLManager;
  let round = 0;
  // Not the singleton: the harness deleted VALKEY_URL before it was picked.
  const bus = new ValkeyRealtimeBus(VALKEY as string);

  /** `getCollection` on every pooled backend at once (see ext-migration-stale-plan). */
  async function readOnEveryConnection(): Promise<string[]> {
    round++;
    let arrived = 0;
    let open!: () => void;
    const allIn = new Promise<void>((r) => {
      open = r;
    });
    const failures: string[] = [];
    await Promise.all(
      Array.from({ length: POOL }, (_, i) =>
        db
          .transaction()
          .execute(async (trx) => {
            try {
              await DDLManager.getCollection(trx, `zz_xr_${round}_${i}`);
            } catch (err) {
              failures.push((err as { errno?: string }).errno ?? String(err));
            }
            if (++arrived === POOL) open();
            await allIn;
          })
          .catch(() => undefined),
      ),
    );
    return failures;
  }

  /** Until this replica's pool was replaced, or long enough that it never will be. */
  async function recycledSince(before: unknown): Promise<void> {
    for (let i = 0; i < 60 && getActiveBunPool() === before; i++) await Bun.sleep(50);
  }

  async function cleanup(): Promise<void> {
    await sql.raw(`ALTER TABLE zvd_collections DROP COLUMN IF EXISTS ${COL}`).execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${EXT}:%`}`.execute(db);
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    ({ DDLManager } = await import('../../lib/data/ddl-manager.js'));
    await cleanup();
    await Bun.write(
      `${DIR}/001_probe.sql`,
      `ALTER TABLE zvd_collections ADD COLUMN ${COL} text;\n-- DOWN\n` +
        `ALTER TABLE zvd_collections DROP COLUMN IF EXISTS ${COL};\n`,
    );
    await bus.start();
  }, 60_000);

  afterAll(async () => {
    await bus.stop();
    if (db) await cleanup().catch(() => undefined);
    await Bun.$`rm -rf ${DIR}`.quiet().nothrow();
  });

  it('a column added to an engine table on replica A', async () => {
    expect(await readOnEveryConnection()).toEqual([]);
    const before = getActiveBunPool();
    await onReplicaA('migrate');
    await recycledSince(before);
    expect(await readOnEveryConnection()).toEqual([]);
  }, 60_000);

  it('that column dropped again by a purge on replica A', async () => {
    expect(await readOnEveryConnection()).toEqual([]);
    const before = getActiveBunPool();
    await onReplicaA('purge');
    await recycledSince(before);
    expect(await readOnEveryConnection()).toEqual([]);
  }, 60_000);
});

(onBun ? describe : describe.skip)('the recycle announcement on the receiving side', () => {
  const msg = (originId: string) => ({
    originId,
    event: POOL_RECYCLE_EVENT,
    collection: '',
    timestamp: new Date().toISOString(),
  });

  beforeAll(async () => {
    await getTestApp();
  });

  it('a burst costs one recycle, and a replica ignores its own', async () => {
    expect(dispatchToWs(msg(ORIGIN_ID))).toBeUndefined();
    const before = getActiveBunPool();
    const first = dispatchToWs(msg('replica-a'));
    expect(dispatchToWs(msg('replica-c'))).toBe(first);
    await first;
    expect(getActiveBunPool()).not.toBe(before);
  }, 10_000);
});
