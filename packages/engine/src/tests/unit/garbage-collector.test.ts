/**
 * Garbage collector (lib/runtime/garbage-collector.ts) — over CannedDb.
 *
 * runGarbageCollector runs the retention purges for the high-churn
 * observability tables. These tests pin the env-gated retention knobs and the
 * best-effort error tolerance. scheduleGarbageCollector
 * is covered for its timer contract without waiting for 03:00.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runGarbageCollector, scheduleGarbageCollector } from '../../lib/runtime/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/** Silence the GC's console.log/warn banner during a test. */
function quiet(): { restore: () => void } {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  return {
    restore: () => {
      log.mockRestore();
      warn.mockRestore();
    },
  };
}

afterEach(() => {
  delete process.env.REQUEST_LOG_RETENTION_DAYS;
  delete process.env.AUDIT_LOG_RETENTION_DAYS;
});

describe('runGarbageCollector — retention purges', () => {
  it('purges request-log + slow-query + audit tables with the configured cutoffs', async () => {
    process.env.REQUEST_LOG_RETENTION_DAYS = '14';
    process.env.AUDIT_LOG_RETENTION_DAYS = '90';
    const db = new CannedDb();
    db.when(/FROM information_schema\.schemata/i, []); // no soft-delete tables
    db.when(/DELETE FROM zv_request_logs/i, [{ deleted: 5 }]);
    db.when(/DELETE FROM zv_slow_queries/i, [{ deleted: 3 }]);
    db.when(/DELETE FROM zv_audit_log/i, [{ deleted: 8 }]);

    const q = quiet();
    try {
      await runGarbageCollector(asDb(db));
    } finally {
      q.restore();
    }

    expect(db.executed(/DELETE FROM zv_request_logs/i)[0]!.parameters).toContain(14);
    expect(db.executed(/DELETE FROM zv_slow_queries/i)).toHaveLength(1);
    expect(db.executed(/DELETE FROM zv_audit_log/i)[0]!.parameters).toContain(90);
  });

  it('skips all retention purges when the knobs are set to 0', async () => {
    process.env.REQUEST_LOG_RETENTION_DAYS = '0';
    process.env.AUDIT_LOG_RETENTION_DAYS = '0';
    const db = new CannedDb();

    const q = quiet();
    try {
      await runGarbageCollector(asDb(db));
    } finally {
      q.restore();
    }

    expect(db.executed(/DELETE FROM zv_request_logs/i)).toHaveLength(0);
    expect(db.executed(/DELETE FROM zv_slow_queries/i)).toHaveLength(0);
    expect(db.executed(/DELETE FROM zv_audit_log/i)).toHaveLength(0);
  });

  // `parseInt('1y')` is 1: a value written as a duration purged every audit row
  // older than a day. A value that is not a whole number of days purges nothing.
  for (const bad of ['1y', '30d', '1e3', '-5', '12.5', 'forever']) {
    it(`purges nothing when a retention knob is ${JSON.stringify(bad)}`, async () => {
      process.env.REQUEST_LOG_RETENTION_DAYS = bad;
      process.env.AUDIT_LOG_RETENTION_DAYS = bad;
      const db = new CannedDb();
      db.when(/FROM information_schema\.schemata/i, []);
      const q = quiet();
      try {
        await runGarbageCollector(asDb(db));
      } finally {
        q.restore();
      }
      expect(db.executed(/DELETE FROM zv_request_logs/i)).toHaveLength(0);
      expect(db.executed(/DELETE FROM zv_slow_queries/i)).toHaveLength(0);
      expect(db.executed(/DELETE FROM zv_audit_log/i)).toHaveLength(0);
    });
  }

  it('defaults to 30d request-log / 365d audit retention when unset', async () => {
    const db = new CannedDb();
    db.when(/DELETE FROM zv_request_logs/i, [{ deleted: 0 }]);
    db.when(/DELETE FROM zv_audit_log/i, [{ deleted: 0 }]);

    const q = quiet();
    try {
      await runGarbageCollector(asDb(db));
    } finally {
      q.restore();
    }

    expect(db.executed(/DELETE FROM zv_request_logs/i)[0]!.parameters).toContain(30);
    expect(db.executed(/DELETE FROM zv_audit_log/i)[0]!.parameters).toContain(365);
  });

  it('a failing purge is swallowed and the remaining purges still run', async () => {
    // The per-purge `.execute(db).catch(() => ({ rows: [] }))` absorbs the DB
    // error inline (yielding 0 deleted), so a failure never aborts the sweep —
    // it silently moves on to the next table.
    const db = new CannedDb();
    db.fail(/DELETE FROM zv_request_logs/i, new Error('lock timeout'));
    db.when(/DELETE FROM zv_slow_queries/i, [{ deleted: 2 }]);
    db.when(/DELETE FROM zv_audit_log/i, [{ deleted: 1 }]);

    const q = quiet();
    try {
      await expect(runGarbageCollector(asDb(db))).resolves.toBeUndefined();
    } finally {
      q.restore();
    }
    // request-logs failed (swallowed) but slow-queries + audit still executed
    expect(db.executed(/DELETE FROM zv_slow_queries/i)).toHaveLength(1);
    expect(db.executed(/DELETE FROM zv_audit_log/i)).toHaveLength(1);
  });

  it('logs retention purge counts when rows are deleted', async () => {
    const db = new CannedDb();
    db.when(/DELETE FROM zv_request_logs/i, [{ deleted: 11 }]);
    db.when(/DELETE FROM zv_slow_queries/i, [{ deleted: 6 }]);
    db.when(/DELETE FROM zv_audit_log/i, [{ deleted: 4 }]);

    const log = spyOn(console, 'log').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runGarbageCollector(asDb(db));
      expect(log.mock.calls.some((c) => String(c[0]).includes('zv_request_logs: 11'))).toBe(true);
      expect(log.mock.calls.some((c) => String(c[0]).includes('zv_slow_queries: 6'))).toBe(true);
      expect(log.mock.calls.some((c) => String(c[0]).includes('zv_audit_log: 4'))).toBe(true);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('scheduleGarbageCollector', () => {
  it('returns a cleanup function and schedules a future run without firing it', async () => {
    const db = new CannedDb();
    const q = quiet();
    try {
      const cancel = scheduleGarbageCollector(asDb(db));
      expect(typeof cancel).toBe('function');
      // The 03:00 timer must not have run any DB work yet.
      expect(db.log).toHaveLength(0);
      cancel();
      cancel(); // idempotent — second call is a no-op
    } finally {
      q.restore();
    }
  });
});
