/**
 * Without Valkey, nothing crossed replicas.
 *
 * `PgNotifyRealtimeBus` listened through `Bun.SQL.subscribe()`, which Bun does
 * not have (1.3.14: `typeof sql.subscribe === 'undefined'`). `start()` caught
 * the TypeError, printed "single-instance only" and returned, so every replica
 * published into a channel nobody listened on: record fan-out, policy and rule
 * changes, `db.pool.recycle`, `extension.lifecycle`, `extension.forward`.
 *
 * Two replicas on one database: this process is B, a second `bun` process A
 * publishes the way a replica does. No pool, no app: the bus owns its connection.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import * as dbModule from '../../db/index.js';
import * as extensions from '../../lib/extensions/index.js';
import { PgNotifyRealtimeBus } from '../../lib/runtime/realtime-bus.js';
import * as tenancy from '../../lib/tenancy/index.js';
import * as ws from '../../routes/ws.js';
import { harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const DB_URL = process.env.TEST_DATABASE_URL as string;
const src = (p: string) => new URL(p, import.meta.url).pathname;

const record = (originId: string, id: string) =>
  JSON.stringify({
    originId,
    event: 'record.created',
    collection: 'pgbus_contacts',
    record_id: id,
    data: { id },
    timestamp: new Date().toISOString(),
    tenantId: 't1',
  });

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  for (let t = 0; t < ms && !cond(); t += 50) await Bun.sleep(50);
}

d('pg_notify realtime bus across replicas', () => {
  const bus = new PgNotifyRealtimeBus(DB_URL);
  const raw = new pg.Client({ connectionString: DB_URL });
  const seen: string[] = [];
  let broadcast: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    broadcast = spyOn(ws, 'broadcastEvent').mockImplementation((_c, _e, data) => {
      seen.push((data as { id: string }).id);
    });
    await raw.connect();
    bus.setPublisher({
      notify: (ch, payload) => raw.query('SELECT pg_notify($1, $2)', [ch, payload]),
    });
    await bus.start();
  });

  afterAll(async () => {
    await bus.stop();
    await raw.end();
    broadcast.mockRestore();
  });

  afterEach(() => {
    seen.length = 0;
  });

  it('B hears a record replica A published', async () => {
    expect(bus.isRunning).toBe(true);
    const script = `
      const { PgNotifyRealtimeBus } = await import(${JSON.stringify(src('../../lib/runtime/realtime-bus.js'))});
      const pg = (await import('pg')).default;
      const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await c.connect();
      const a = new PgNotifyRealtimeBus(process.env.TEST_DATABASE_URL);
      a.setPublisher({ notify: (ch, p) => c.query('SELECT pg_notify($1, $2)', [ch, p]) });
      await a.publish({ event: 'record.created', collection: 'pgbus_contacts', record_id: 'from-a',
        data: { id: 'from-a' }, timestamp: new Date().toISOString(), tenantId: 't1' });
      await c.end();
      process.exit(0);
    `;
    const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe' });
    if ((await proc.exited) !== 0)
      throw new Error(`replica A failed: ${await new Response(proc.stderr).text()}`);
    await until(() => seen.length > 0);
    expect(seen).toEqual(['from-a']);
    expect(broadcast).toHaveBeenCalledWith('pgbus_contacts', 'insert', { id: 'from-a' }, 't1');
  });

  it('drops its own echo and a malformed payload, delivers what follows in order', async () => {
    await bus.publish(JSON.parse(record('ignored', 'own-echo')));
    await raw.query("SELECT pg_notify('zveltio_changes', '{not json')");
    await raw.query('SELECT pg_notify($1, $2)', ['zveltio_changes', record('replica-a', 'after')]);
    await until(() => seen.length > 0);
    await Bun.sleep(100);
    expect(seen).toEqual(['after']);
  });

  it('a killed LISTEN connection comes back, resyncs, and hears again', async () => {
    const reconcile = spyOn(tenancy, 'reconcilePolicies').mockResolvedValue(false);
    const sync = spyOn(extensions.extensionLoader, 'syncAllWithRegistry').mockResolvedValue();
    const forward = spyOn(extensions, 'refreshForwardApproval').mockResolvedValue();
    const recycle = spyOn(dbModule, 'recycleActivePool').mockResolvedValue();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const killed = await raw.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE application_name = 'zveltio-realtime-bus' AND pid <> pg_backend_pid()`,
      );
      expect(killed.rowCount).toBeGreaterThan(0);
      await until(() => !bus.isRunning, 2_000);
      await until(() => bus.isRunning && reconcile.mock.calls.length > 0, 5_000);
      expect(bus.isRunning).toBe(true);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledTimes(1);
      await raw.query('SELECT pg_notify($1, $2)', ['zveltio_changes', record('replica-a', 'back')]);
      await until(() => seen.length > 0);
      expect(seen).toEqual(['back']);
      await until(() => recycle.mock.calls.length > 0, 2_000); // coalesced recycle, 500 ms later
    } finally {
      reconcile.mockRestore();
      sync.mockRestore();
      forward.mockRestore();
      recycle.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  }, 15_000);
});
