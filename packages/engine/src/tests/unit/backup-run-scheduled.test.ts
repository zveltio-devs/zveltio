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

/**
 * Every spawn this file saw, in order.
 *
 * The archive on disk says the fake wrote a file; it says nothing about whether
 * the command that would have written the real one was assembled correctly. The
 * wiring assertions below read this instead.
 */
type SpawnCall = { cmd: string[]; opts: Record<string, unknown>; result: { stdout?: unknown } };
let calls: SpawnCall[] = [];
const callFor = (bin: string): SpawnCall => {
  const c = calls.find((x) => x.cmd[0] === bin);
  if (!c) throw new Error(`no ${bin} spawn was recorded`);
  return c;
};

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
 * `gzip -c </dev/null` is exactly 20 bytes — a valid archive of nothing, which
 * passes `gzip -t`. Only the size distinguishes it from a real dump, so the
 * stand-in here only has to match that size.
 */
const EMPTY_ARCHIVE = 'x'.repeat(20);

/**
 * Fake the four commands the dump path spawns.
 *
 * `writeFile` decides whether gzip actually produces the archive — which is the
 * difference between a real backup and a dump that reported success and left
 * nothing behind.
 */
function fakeSpawn(
  opts: {
    dumpExit?: number;
    stderr?: string;
    writeFile?: boolean;
    gzipExit?: number;
    gzipStderr?: string;
    payload?: string;
  } = {},
) {
  const {
    dumpExit = 0,
    stderr = '',
    writeFile = true,
    gzipExit = 0,
    gzipStderr = '',
    payload = PAYLOAD,
  } = opts;
  lastDest = null;
  calls = [];
  return spyOn(Bun, 'spawn').mockImplementation(((
    cmd: string[],
    o?: { stdout?: { name?: string } },
  ) => {
    const record = <T>(r: T): T => {
      calls.push({
        cmd,
        opts: (o ?? {}) as Record<string, unknown>,
        result: r as { stdout?: unknown },
      });
      return r;
    };
    if (cmd[0] === 'gzip') {
      // Where the archive actually goes, taken from the call rather than rebuilt
      // from BACKUP_DIR: the module reads that env var once, at load, and which
      // file loads it first is not this test's to decide.
      const dest = o?.stdout?.name ?? null;
      lastDest = dest;
      if (dest) written.push(dest);
      const done =
        writeFile && dest
          ? Bun.write(dest, payload).then(() => gzipExit)
          : Promise.resolve(gzipExit);
      return record({
        exited: done,
        exitCode: gzipExit,
        stderr: new Response(gzipStderr).body,
      }) as never;
    }
    if (cmd[0] === 'pg_dump') return record(proc(dumpExit, stderr)) as never;
    return record(proc(0)) as never;
  }) as unknown as typeof Bun.spawn);
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

  it('treats a gzip that died mid-write as a failure, even though pg_dump exited 0', async () => {
    // The worst shape a backup can take, and the one the checks used to miss
    // entirely: the disk fills at the tail of the write, gzip dies on SIGXFSZ
    // (128 + 25 = 153), and pg_dump — whose whole output already fitted in the
    // pipe buffer — exits 0. A truncated archive EXISTS, so `exists()` is happy
    // and the row said `completed`. Measured against real processes under
    // `ulimit -f 1`: pg_dump 0, gzip 153, 1024 of 31047 bytes, `gzip -t` fails.
    //
    // `dr-drill.sh` already carries this lesson in prose — "a pg_dump that
    // failed halfway would have been reported as a passing backup, which is the
    // single worst thing a drill can do". It was applied to the shell script and
    // not to the product.
    const spy = fakeSpawn({ gzipExit: 153, gzipStderr: 'gzip: stdout: File size limit exceeded' });
    const db = cannedDb();

    const out = await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-gzip',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    expect(out.status).toBe('failed');
    expect(out.error).toContain('gzip');
    expect(out.error).toContain('153');
    expect(db.executed(UPDATE_BACKUP)[0]!.sql).toContain("status = 'failed'");
    expect(db.executed(UPDATE_SCHEDULE).length).toBe(1);
  });

  it('treats an archive holding no dump as a failure, not a 20-byte success', async () => {
    // Both processes exit 0 and a perfectly valid file appears — it just has
    // nothing in it. `gzip -c </dev/null` is 20 bytes and passes `gzip -t`, so
    // neither the exit codes nor the existence check nor an integrity check can
    // tell this from a real backup. Only the size can.
    const spy = fakeSpawn({ payload: EMPTY_ARCHIVE });
    const db = cannedDb();

    const out = await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-hollow',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    expect(out.status).toBe('failed');
    expect(out.error).toContain('no data');
    expect(db.executed(UPDATE_BACKUP)[0]!.sql).toContain("status = 'failed'");
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

describe('runScheduledBackup — the wiring itself', () => {
  // Coverage said 100% of these lines ran. It could not say the command was
  // built correctly, because nothing looked: the fake reads `cmd[0]` and the
  // gzip destination and ignores everything else. Measured — with `-h`/`-p`
  // swapped, PGPASSWORD dropped and gzip's stdin detached ALL AT ONCE, the full
  // suite still reported 2633 unit + 1030 harness passing.
  //
  // These assertions read the spy instead of the disk. No subprocess, so no
  // dependence on the runner's pg_dump being new enough for the server.

  it('passes each pg_dump flag its own value, not the next one along', async () => {
    const spy = fakeSpawn();
    const db = cannedDb();
    await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-argv',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    const { cmd } = callFor('pg_dump');
    // Pairs, not membership: swapping -h with -p leaves every token present.
    expect(cmd[cmd.indexOf('-h') + 1]).toBe(target().host);
    expect(cmd[cmd.indexOf('-p') + 1]).toBe(String(target().port));
    expect(cmd[cmd.indexOf('-U') + 1]).toBe(target().user);
    expect(cmd[cmd.indexOf('-d') + 1]).toBe(target().name);
  });

  it('hands pg_dump the password through the environment', async () => {
    const spy = fakeSpawn();
    const db = cannedDb();
    await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-pw',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    const env = callFor('pg_dump').opts.env as Record<string, string>;
    // Without it pg_dump prompts, gets no tty, and fails — but only against a
    // server that asks for a password, which a local trust-auth box may not.
    expect(env.PGPASSWORD).toBe(target().password);
  });

  it("connects gzip's stdin to pg_dump's stdout, and starts the dump first", async () => {
    const spy = fakeSpawn();
    const db = cannedDb();
    await runScheduledBackup(db.kysely as unknown as Database, {
      scheduleId: 'sched-pipe',
      scheduleName: 'Nightly',
      target: target(),
      actorId: null,
    });
    spy.mockRestore();

    // Identity, not truthiness: a detached stdin still produces a valid (empty)
    // archive, which is exactly how this would pass unnoticed.
    const dump = callFor('pg_dump');
    const gzip = callFor('gzip');
    expect(dump.result.stdout).toBeDefined();
    expect(gzip.opts.stdin).toBe(dump.result.stdout);
    expect(calls.indexOf(dump)).toBeLessThan(calls.indexOf(gzip));
  });
});
