/**
 * DDL queue (lib/data/ddl-queue.ts) — the pg-boss-independent surface.
 *
 * The queue is backed by a module-level pg-boss singleton created only inside
 * initDDLQueue(); these tests cover everything reachable WITHOUT a live boss:
 *   - the pure job-shape mapper (state → status, date coercion, error extract),
 *   - the enqueue/getJob/started guards when the queue isn't running,
 *   - initDDLQueue's no-DATABASE_URL early return,
 *   - and the BYOD guard + invalid-index
 *     reindex, exposed via `_internalForTests`, driven over CannedDb.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  _internalForTests,
  _setBossForTests,
  enqueueDDLJob,
  getDDLJob,
  isDDLQueueStarted,
} from '../../lib/data/ddl-queue.js';
import { initDDLQueue } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const { mapJobToPublic, QUEUE_NAMES, skipForByod, reindexInvalid } = _internalForTests;

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

function spyOnConsoleWarn() {
  const spy = spyOn(console, 'warn').mockImplementation(() => {});
  return { calls: spy.mock.calls, restore: () => spy.mockRestore() };
}

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('mapJobToPublic', () => {
  it('maps pg-boss states to the public status vocabulary', () => {
    const cases: Array<[string, string]> = [
      ['created', 'pending'],
      ['retry', 'pending'],
      ['active', 'running'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'failed'],
      ['expired', 'failed'],
      ['weird_unknown', 'pending'],
    ];
    for (const [state, status] of cases) {
      const out = mapJobToPublic(
        { id: 'j1', data: { x: 1 }, state, createdOn: '2026-07-09T00:00:00Z' },
        'add_field',
      );
      expect(String(out.status)).toBe(status);
    }
  });

  it('coerces timestamps and extracts the error message shape', () => {
    const withObjErr = mapJobToPublic(
      {
        id: 'j2',
        data: { a: 1 },
        state: 'failed',
        startedOn: '2026-07-09T01:00:00Z',
        completedOn: '2026-07-09T01:05:00Z',
        output: { message: 'boom' },
        retryCount: 2,
        retryLimit: 5,
        createdOn: '2026-07-09T00:00:00Z',
      },
      'create_collection',
    );
    expect(withObjErr.type).toBe('create_collection');
    expect(withObjErr.payload).toEqual({ a: 1 });
    expect(withObjErr.started_at).toBeInstanceOf(Date);
    expect(withObjErr.completed_at).toBeInstanceOf(Date);
    expect(withObjErr.error).toBe('boom');
    expect(withObjErr.retry_count).toBe(2);
    expect(withObjErr.max_retries).toBe(5);

    const withStrErr = mapJobToPublic(
      {
        id: 'j3',
        state: 'failed',
        output: 'plain string error',
        createdOn: '2026-07-09T00:00:00Z',
      },
      'add_field',
    );
    expect(withStrErr.error).toBe('plain string error');
    expect(withStrErr.started_at).toBeNull();
    expect(withStrErr.completed_at).toBeNull();
    expect(withStrErr.retry_count).toBe(0); // default when absent
    expect(withStrErr.max_retries).toBe(3); // DEFAULT_RETRY.retryLimit
  });

  it('maps every declared DDL type to a `ddl.` queue name', () => {
    expect(QUEUE_NAMES.create_collection).toBe('ddl.create_collection');
    for (const q of Object.values(QUEUE_NAMES)) expect(q.startsWith('ddl.')).toBe(true);
  });
});

describe('guards when the queue is not running', () => {
  // "Not running" has to be true of THIS process, and in a full `bun test` run
  // it is not: a harness file boots the app, which starts the queue for every
  // file after it. These three then measured a running queue — the enqueue case
  // really enqueued and sat until its 30s deadline. Pin the state, restore it
  // after, so the guards are exercised whatever else ran first.
  let previousBoss: unknown;
  beforeAll(() => {
    previousBoss = _setBossForTests(null);
  });
  afterAll(() => {
    _setBossForTests(previousBoss);
  });

  it('isDDLQueueStarted is false and getDDLJob returns null', async () => {
    const db = new CannedDb();
    expect(isDDLQueueStarted()).toBe(false);
    expect(await getDDLJob(asDb(db), 'any-id')).toBeNull();
  });

  it('enqueueDDLJob throws a clear "not initialized" error', async () => {
    const db = new CannedDb();
    await expect(enqueueDDLJob(asDb(db), 'add_field', {})).rejects.toThrow('not initialized');
  });

  it('initDDLQueue without DATABASE_URL warns and stays stopped', async () => {
    const warn = spyOnConsoleWarn();
    try {
      const db = new CannedDb();
      await initDDLQueue(asDb(db));
      expect(isDDLQueueStarted()).toBe(false);
      expect(warn.calls.some((c) => String(c[0]).includes('DATABASE_URL not set'))).toBe(true);
    } finally {
      warn.restore();
    }
  });
});

describe('skipForByod', () => {
  it('returns true only for is_managed=false collections', async () => {
    const managed = new CannedDb();
    managed.when(/select "is_managed" from "zvd_collections"/, [{ is_managed: true }]);
    expect(await skipForByod(asDb(managed), { collection: 'contacts' }, 'add_field')).toBe(false);

    const byod = new CannedDb();
    byod.when(/select "is_managed" from "zvd_collections"/, [{ is_managed: false }]);
    expect(await skipForByod(asDb(byod), { name: 'external' }, 'drop_collection')).toBe(true);
  });

  /**
   * This test used to assert `false` — "go ahead" — and it passed, which is what
   * kept the defect in place.
   *
   * `skipForByod` answers "is this collection ours to alter?". Its callers are
   * `drop_collection`, `remove_field` and `add_field`. Returning false on a
   * FAILED lookup meant a transient database error while asking that question
   * answered yes, and the engine would drop a column — or a whole table — that
   * an operator had explicitly marked `is_managed = false`, a BYOD table holding
   * their own data.
   *
   * Unknown ownership is the one case where doing nothing is always recoverable
   * and doing something may not be.
   */
  it('skips the job when the collection lookup fails, rather than running DDL blind', async () => {
    const db = new CannedDb();
    db.fail(/select "is_managed" from "zvd_collections"/i, new Error('relation missing'));
    expect(await skipForByod(asDb(db), { collection: 'ghost' }, 'add_field')).toBe(true);
  });

  it('returns false when the payload names no collection', async () => {
    const db = new CannedDb();
    expect(await skipForByod(asDb(db), {}, 'add_field')).toBe(false);
    expect(db.log).toHaveLength(0);
  });
});

describe('reindexInvalid', () => {
  it('reindexes every invalid zv_/zvd_ index found', async () => {
    const db = new CannedDb();
    db.when(/pg_stat_user_indexes/i, [
      { schemaname: 'public', indexname: 'idx_zvd_orders_status' },
      { schemaname: 'public', indexname: 'idx_zv_audit_created' },
    ]);
    await reindexInvalid(asDb(db));
    expect(
      db.executed(/REINDEX INDEX CONCURRENTLY "public"\."idx_zvd_orders_status"/),
    ).toHaveLength(1);
    expect(db.executed(/REINDEX INDEX CONCURRENTLY/)).toHaveLength(2);
  });

  it('warns but continues when a single REINDEX fails', async () => {
    const warn = spyOnConsoleWarn();
    try {
      const db = new CannedDb();
      db.when(/pg_stat_user_indexes/i, [
        { schemaname: 'public', indexname: 'idx_zvd_broken' },
        { schemaname: 'public', indexname: 'idx_zvd_ok' },
      ]);
      db.fail(/REINDEX INDEX CONCURRENTLY "public"\."idx_zvd_broken"/, new Error('deadlock'));
      await reindexInvalid(asDb(db));
      expect(db.executed(/REINDEX INDEX CONCURRENTLY "public"\."idx_zvd_ok"/)).toHaveLength(1);
      expect(warn.calls.some((c) => String(c[0]).includes('idx_zvd_broken'))).toBe(true);
    } finally {
      warn.restore();
    }
  });
});
