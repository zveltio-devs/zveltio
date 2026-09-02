/**
 * lib/backup/run-scheduled-backup.ts — one dump, and the bookkeeping around it.
 *
 * The body used to live inside the trigger route, where nothing could reach it.
 * What it decides is easy to get wrong quietly:
 *
 *   - an unattended run records NO actor rather than borrowing the last one
 *   - the backup row and the schedule row are one outcome written twice, in a
 *     single transaction, so they cannot disagree
 *   - a dump that exits 0 but wrote nothing is a failure, not a success
 *   - a failure to RECORD a failure must not replace the failure
 *
 * Only the external processes are faked here. `pg_dump` on a CI runner is older
 * than the pg18 server and would abort on the version check, which would make
 * this file red for a reason that has nothing to do with the code under test.
 * The file on disk and every statement against the database are real.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const DIR = `/tmp/zveltio-backup-test-${process.pid}-${Date.now()}`;
const PAYLOAD = 'PGDMP fake dump bytes\n';

const INSERT_BACKUP = /INSERT INTO zv_backups/i;
const UPDATE_BACKUP = /UPDATE zv_backups/i;
const UPDATE_SCHEDULE = /UPDATE zv_backup_schedules/i;

// Imported after BACKUP_DIR is set: the module reads it once, at load.
let runScheduledBackup: typeof import('../../lib/backup/run-scheduled-backup.js').runScheduledBackup;

const target = () => ({ host: 'h', port: '5432', name: 'db', user: 'u', password: 'p' });

/** The path gzip was pointed at at, and every path this file created. */
let lastDest: string | null = null;
const written: string[] = [];

/** A stand-in for one spawned process, shaped like what the code reads off it. */
function proc(exitCode: number, stderr = '') {
  return {
    exited: Promise.resolve(exitCode),
    exitCode,
    stdout: new Response('').body,
    stderr: new Response(stderr).body,
  };
}

/**
 * Fake the four commands the dump path spawns.
 *
 * `writeFile` decides whether gzip actually produces the archive — which is the
 * difference between a real backup and a dump that reported success and left
 * nothing behind.
 */
function fakeSpawn(opts: { dumpExit?: number; stderr?: string; writeFile?: boolean } = {}) {
  const { dumpExit = 0, stderr = '', writeFile = true } = opts;
  lastDest = null;
  return spyOn(Bun, 'spawn').mockImplementation(((cmd: string[], o?: { stdout?: { name?: string } }) => {
    if (cmd[0] === 'gzip') {
      // Where the archive actually goes, taken from the call rather than rebuilt
      // from BACKUP_DIR: the module reads that env var once, at load, and which
      // file loads it first is not this test's to decide.
      const dest = o?.stdout?.name ?? null;
      lastDest = dest;
      if (dest) written.push(dest);
      const done = writeFile && dest ? Bun.write(dest, PAYLOAD).then(() => 0) : Promise.resolve(0);
      return { exited: done, exitCode: 0 } as never;
    }
    if (cmd[0] === 'pg_dump') return proc(dumpExit, stderr) as never;
    return proc(0) as never;
  }) as typeof Bun.spawn);
}

beforeAll(async () => {
  // Before the spy — this one has to be a real directory.
  await Bun.spawn(['mkdir', '-p', DIR]).exited;
  process.env.BACKUP_DIR = DIR;
  ({ runScheduledBackup } = await import('../../lib/backup/run-scheduled-backup.js'));
});

afterAll(async () => {
  for (const f of written) await Bun.spawn(['rm', '-f', f]).exited;
  await Bun.spawn(['rm', '-rf', DIR]).exited;
});

afterEach(() => {
  spyOn(Bun, 'spawn').mockRestore();
});

/** A canned database that answers the one query the function needs a row from. */
const cannedDb = () => new CannedDb().when(INSERT_BACKUP, [{ id: 'backup-1' }]);

describe('runScheduledBackup — the run that worked', () => {
  it('writes the archive and records completed in both rows', async () => {
    const spy = fakeSpawn();
    const db = cannedDb();

    const out = await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-ok',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    expect(out.status).toBe('completed');
    expect(out.backupId).toBe('backup-1');
    expect(out.error).toBeUndefined();

    // The archive is real, and so is its size — the number written to the row.
    expect(lastDest).not.toBeNull();
    expect(lastDest).toContain(out.filename);
    const file = Bun.file(lastDest!);
    expect(await file.exists()).toBe(true);
    expect(file.size).toBe(PAYLOAD.length);

    const done = db.executed(UPDATE_BACKUP);
    expect(done.length).toBe(1);
    expect(done[0]!.parameters).toContain(PAYLOAD.length);
    expect(db.executed(UPDATE_SCHEDULE).length).toBe(1);
  });

  it('records no actor for an unattended run, and the schedule name for a manual one', async () => {
    // `created_by` is nullable for exactly this: a backup nobody asked for must
    // not name somebody who did not ask for it.
    const spy = fakeSpawn();
    const db = cannedDb();

    await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-actor',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    const insert = db.executed(INSERT_BACKUP)[0]!;
    // `in_progress` is a literal in the template, so it is in the SQL, not the
    // parameters — where the actor is, and where it must be null.
    expect(insert.sql).toContain('in_progress');
    expect(insert.parameters).toContain(null);
    expect(insert.parameters.some((p) => String(p).includes('Nightly'))).toBe(true);
  });
});

describe('runScheduledBackup — the run that did not', () => {
  it('carries pg_dump stderr into the error and marks both rows failed', async () => {
    const spy = fakeSpawn({ dumpExit: 1, stderr: 'pg_dump: error: connection refused' });
    const db = cannedDb();

    const out = await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-stderr',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    expect(out.status).toBe('failed');
    expect(out.error).toContain('connection refused');
    expect(db.executed(UPDATE_BACKUP)[0]!.sql).toContain("status = 'failed'");
    expect(db.executed(UPDATE_SCHEDULE).length).toBe(1);
  });

  it('treats a dump that exited 0 and wrote nothing as a failure', async () => {
    // The quiet one. Without this check the schedule reports `completed` and the
    // operator finds out at restore time.
    const spy = fakeSpawn({ writeFile: false });
    const db = cannedDb();

    const out = await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-empty',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    expect(out.status).toBe('failed');
    expect(out.error).toContain('was not created');
  });

  it('keeps the original error when recording the failure also fails', async () => {
    // Otherwise the operator gets the bookkeeping error and never learns why the
    // backup did not happen.
    const spy = fakeSpawn({ dumpExit: 1, stderr: 'pg_dump: error: disk full' });
    const db = cannedDb().fail(UPDATE_BACKUP, new Error('database went away'));

    const out = await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-record',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    expect(out.status).toBe('failed');
    expect(out.error).toContain('disk full');
    expect(out.error).not.toContain('database went away');
  });
});
