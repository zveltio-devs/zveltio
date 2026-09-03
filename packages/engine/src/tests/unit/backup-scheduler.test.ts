/**
 * lib/backup/scheduler.ts — the loop that makes a backup schedule a schedule.
 *
 * These pin the decisions that could be wrong silently. Each of them was made
 * because the wrong version is plausible and its failure mode is quiet:
 *
 *   - the next occurrence is written BEFORE the dump, not after
 *   - an unparseable cron expression deactivates the schedule instead of being
 *     retried every minute for ever
 *   - a schedule with no `next_run_at` is primed at startup, because every row
 *     in every existing install is in exactly that state
 *
 * The end-to-end behaviour (a real engine writing a real 31 kB dump on its own)
 * was verified separately against a live database; that cannot run here, and
 * these are the parts that hold the logic.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { scheduleBackups, setNextRun } from '../../lib/backup/scheduler.js';
import { CannedDb } from './fixtures/canned-db.js';

// Raw `sql` templates, so the table name is unquoted — matching the quoted form
// the query builder emits found nothing and every assertion read as zero.
const SELECT_DUE = /select[\s\S]*from zv_backup_schedules[\s\S]*next_run_at <= NOW\(\)/i;
const SELECT_UNPRIMED = /select[\s\S]*from zv_backup_schedules[\s\S]*next_run_at IS NULL/i;
const UPDATE_SCHEDULE = /UPDATE zv_backup_schedules/i;
// The claim is the only UPDATE on this table that returns anything — that is
// how the tick learns whether it won the occurrence or another replica did.
const CLAIM = /UPDATE zv_backup_schedules[\s\S]*RETURNING/i;

const target = () => ({ host: 'h', port: '5432', name: 'db', user: 'u', password: 'p' });

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
});

describe('setNextRun', () => {
  it('computes the next occurrence and stores it', async () => {
    const db = new CannedDb();
    const from = new Date('2026-09-02T10:30:00.000Z');
    const next = await setNextRun(db.kysely as unknown as Database, 'sched-1', '0 3 * * *', from);

    expect(next?.toISOString()).toBe('2026-09-03T03:00:00.000Z');
    const writes = db.executed(UPDATE_SCHEDULE);
    expect(writes.length).toBe(1);
    expect(writes[0]!.parameters).toContain('sched-1');
  });

  it('returns null for an expression cron cannot parse, and still writes NULL', async () => {
    // The write matters as much as the null: leaving a stale `next_run_at` from
    // a previous, valid expression would keep firing at the old times after an
    // edit that the operator believes changed them.
    const db = new CannedDb();
    const next = await setNextRun(db.kysely as unknown as Database, 'sched-1', 'not a cron');

    expect(next).toBeNull();
    expect(db.executed(UPDATE_SCHEDULE).length).toBe(1);
  });
});

describe('scheduleBackups — startup priming', () => {
  it('gives a next run to schedules that have none', async () => {
    // Every schedule ever created is in this state, because nothing computed the
    // marker until the scheduler existed. Without priming, the loop would start,
    // find nothing due, and stay that way — indistinguishable from the bug it
    // was written to fix.
    const db = new CannedDb();
    db.when(SELECT_UNPRIMED, [{ id: 'sched-1', cron_expression: '0 3 * * *' }]);
    db.when(SELECT_DUE, []);

    stop = scheduleBackups(db.kysely as unknown as Database, target);
    await db.waitFor(UPDATE_SCHEDULE);

    const writes = db.executed(UPDATE_SCHEDULE);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]!.parameters).toContain('sched-1');
  });

  it('deactivates a schedule whose cron cannot be parsed', async () => {
    // Otherwise it sits `is_active = true` with `next_run_at` NULL — skipped by
    // the due query for ever, and never mentioned again. The API warns once at
    // creation; nobody reads that a month later.
    const db = new CannedDb();
    db.when(SELECT_UNPRIMED, [{ id: 'bad-1', cron_expression: 'nonsense' }]);
    db.when(SELECT_DUE, []);

    // Wait for the UPDATE specifically. `/is_active/` also matches the SELECT
    // that runs first, so waiting on that resolved before the write existed and
    // the assertion below read zero.
    const DEACTIVATE = /UPDATE zv_backup_schedules SET is_active = false/i;
    stop = scheduleBackups(db.kysely as unknown as Database, target);
    await db.waitFor(DEACTIVATE);

    const off = db.executed(DEACTIVATE);
    expect(off.length).toBeGreaterThan(0);
    // `invalid_cron` is inlined in the statement, not bound — it is a literal in
    // the template, so it never appears in `parameters`.
    expect(off[0]!.sql).toContain('invalid_cron');
    expect(off[0]!.parameters).toContain('bad-1');
  });
});

describe('scheduleBackups — the due query', () => {
  it('asks only for active schedules with a marker that has passed', async () => {
    // A NULL marker must not be treated as "due now": that would fire every
    // schedule the moment the engine booted.
    const db = new CannedDb();
    db.when(SELECT_UNPRIMED, []);
    db.when(SELECT_DUE, []);

    stop = scheduleBackups(db.kysely as unknown as Database, target);
    await db.waitFor(SELECT_DUE);

    const [q] = db.executed(SELECT_DUE);
    expect(q!.sql).toMatch(/is_active = true/i);
    expect(q!.sql).toMatch(/next_run_at is not null/i);
    expect(q!.sql).toMatch(/next_run_at <= NOW\(\)/i);
  });
});

describe('scheduleBackups — one tick', () => {
  // The dump itself is faked: what a tick decides is the order of its writes and
  // whether it starts a dump at all, and a real `pg_dump` here would only add a
  // DNS timeout to every case.
  function fakeSpawn() {
    return spyOn(Bun, 'spawn').mockImplementation(((
      cmd: string[],
      o?: { stdout?: { name?: string } },
    ) => {
      if (cmd[0] === 'gzip') {
        const dest = o?.stdout?.name;
        // Comfortably above EMPTY_ARCHIVE_BYTES: a one-byte file is now refused
        // as an archive holding no dump, which would make every tick here fail.
        const done = dest ? Bun.write(dest, 'x'.repeat(64)).then(() => 0) : Promise.resolve(0);
        return { exited: done, exitCode: 0 } as never;
      }
      return {
        exited: Promise.resolve(0),
        exitCode: 0,
        stdout: new Response('').body,
        stderr: new Response('').body,
      } as never;
    }) as unknown as typeof Bun.spawn);
  }

  const due = (cron: string) => [
    { id: 'sched-1', name: 'Nightly', cron_expression: cron, next_run_at: new Date() },
  ];

  it('writes the next occurrence before it starts the dump', async () => {
    // The order is the whole point. Written afterwards, a dump that outlives a
    // tick would be found still due and started again; advancing first makes the
    // worst case a missed run rather than a duplicated one.
    const spy = fakeSpawn();
    const db = new CannedDb()
      .when(SELECT_UNPRIMED, [])
      .when(SELECT_DUE, due('0 3 * * *'))
      .when(CLAIM, [{ id: 'sched-1' }])
      .when(/INSERT INTO zv_backups/i, [{ id: 'backup-1' }]);

    stop = scheduleBackups(db.kysely as unknown as Database, target);
    await db.waitFor(/INSERT INTO zv_backups/i);
    spy.mockRestore();

    const order = db.executed(/UPDATE zv_backup_schedules|INSERT INTO zv_backups/i);
    expect(order[0]!.sql).toMatch(/UPDATE zv_backup_schedules/i);
    expect(order[0]!.sql).toMatch(/next_run_at/i);
    expect(order[1]!.sql).toMatch(/INSERT INTO zv_backups/i);
  });

  it('starts no dump when another replica already claimed the occurrence', async () => {
    // Every replica ticks and every one of them reads the same due row. Before
    // the claim was conditional, all of them started a dump: N concurrent
    // pg_dumps of the whole database, N rows, N uploads of the same bytes. The
    // only guard was an in-process Set, which cannot see the other replicas.
    //
    // A claim that updates zero rows means someone else moved the marker first.
    // That is the normal case on every instance but one, so it must be silent
    // and it must not dump.
    const spy = fakeSpawn();
    const db = new CannedDb()
      .when(SELECT_UNPRIMED, [])
      .when(SELECT_DUE, due('0 3 * * *'))
      .when(CLAIM, []) // lost the race
      .when(/INSERT INTO zv_backups/i, [{ id: 'backup-1' }]);

    stop = scheduleBackups(db.kysely as unknown as Database, target);
    await db.waitFor(CLAIM);
    spy.mockRestore();

    expect(db.executed(CLAIM).length).toBe(1);
    expect(db.executed(/INSERT INTO zv_backups/i).length).toBe(0);
  });

  it('claims on the marker still being due, not on an exact timestamp match', async () => {
    // The obvious form — AND next_run_at = <the value this tick read> — is a
    // trap: the column is timestamptz(6) and a JS Date carries milliseconds, so
    // a value written by any other path would never match and the schedule would
    // silently never run again. That is a worse failure than the duplicate dumps
    // this fixes, so the shape of the predicate is pinned here.
    const spy = fakeSpawn();
    const db = new CannedDb()
      .when(SELECT_UNPRIMED, [])
      .when(SELECT_DUE, due('0 3 * * *'))
      .when(CLAIM, [{ id: 'sched-1' }])
      .when(/INSERT INTO zv_backups/i, [{ id: 'backup-1' }]);

    stop = scheduleBackups(db.kysely as unknown as Database, target);
    await db.waitFor(CLAIM);
    spy.mockRestore();

    const [claim] = db.executed(CLAIM);
    // Only the WHERE clause: `SET next_run_at = $1` is the write, and it is the
    // condition that must not be an equality.
    const where = claim!.sql.split(/\bWHERE\b/i)[1] ?? '';
    expect(where).toMatch(/next_run_at <= NOW\(\)/i);
    expect(where).toMatch(/is_active = true/i);
    expect(where).not.toMatch(/next_run_at\s*=\s*\$/i);
  });

  it('deactivates a due schedule whose cron cannot be parsed, and starts no dump', async () => {
    // Otherwise it is retried every minute for ever, and nothing says so.
    const spy = fakeSpawn();
    const db = new CannedDb().when(SELECT_UNPRIMED, []).when(SELECT_DUE, due('not a cron'));

    stop = scheduleBackups(db.kysely as unknown as Database, target);
    await db.waitFor(/is_active = false/i);
    spy.mockRestore();

    expect(db.executed(/last_run_status = 'invalid_cron'/i).length).toBe(1);
    expect(db.executed(/INSERT INTO zv_backups/i).length).toBe(0);
  });

  it('survives a tick that cannot read the table', async () => {
    // The database may be restarting. The next tick is a minute away, and a throw
    // here would take the loop with it.
    const db = new CannedDb()
      .when(SELECT_UNPRIMED, [])
      .fail(SELECT_DUE, new Error('the database is restarting'));

    stop = scheduleBackups(db.kysely as unknown as Database, target);
    await db.waitFor(SELECT_DUE);

    // Still stoppable — the loop is alive, not unwound by the error.
    expect(() => stop?.()).not.toThrow();
    expect(db.executed(/INSERT INTO zv_backups/i).length).toBe(0);
  });
});
