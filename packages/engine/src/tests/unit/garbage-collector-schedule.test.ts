/**
 * garbage-collector.ts — scheduled timer callback + purge outer-catch branches.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runGarbageCollector, scheduleGarbageCollector } from '../../lib/runtime/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

afterEach(() => {
  delete process.env.REQUEST_LOG_RETENTION_DAYS;
  delete process.env.AUDIT_LOG_RETENTION_DAYS;
});

describe('scheduleGarbageCollector — timer callback', () => {
  it('runs garbage collection when the scheduled timer fires', async () => {
    const db = new CannedDb();
    db.when(/FROM information_schema\.schemata/i, []);

    let captured: (() => void) | null = null;
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, _ms?: number) => {
      captured = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cancel = scheduleGarbageCollector(asDb(db));
      expect(captured).not.toBeNull();
      await captured!();
      expect(db.executed(/FROM information_schema\.schemata/i).length).toBeGreaterThan(0);
      cancel();
    } finally {
      globalThis.setTimeout = origSetTimeout;
      log.mockRestore();
    }
  });

  it('logs an error when the scheduled run rejects', async () => {
    const db = new CannedDb();
    db.fail(/FROM information_schema\.schemata/i, new Error('db offline'));

    let captured: (() => void) | null = null;
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      captured = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      scheduleGarbageCollector(asDb(db));
      await captured!();
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('Error during garbage collection')),
      ).toBe(true);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      errSpy.mockRestore();
      log.mockRestore();
    }
  });
});

describe('runGarbageCollector — purge outer catch', () => {
  it('warns when request-log purge logging throws', async () => {
    process.env.REQUEST_LOG_RETENTION_DAYS = '7';
    const db = new CannedDb();
    db.when(/FROM information_schema\.schemata/i, []);
    db.when(/DELETE FROM zv_request_logs/i, [{ deleted: 3 }]);

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('zv_request_logs')) {
        throw new Error('log sink broken');
      }
    });
    try {
      await runGarbageCollector(asDb(db));
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('zv_request_logs purge failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('warns when slow-query purge logging throws', async () => {
    process.env.REQUEST_LOG_RETENTION_DAYS = '7';
    const db = new CannedDb();
    db.when(/FROM information_schema\.schemata/i, []);
    db.when(/DELETE FROM zv_request_logs/i, [{ deleted: 0 }]);
    db.when(/DELETE FROM zv_slow_queries/i, [{ deleted: 2 }]);

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('zv_slow_queries')) {
        throw new Error('log sink broken');
      }
    });
    try {
      await runGarbageCollector(asDb(db));
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('zv_slow_queries purge failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('warns when audit-log purge logging throws', async () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = '30';
    const db = new CannedDb();
    db.when(/FROM information_schema\.schemata/i, []);
    db.when(/DELETE FROM zv_audit_log/i, [{ deleted: 4 }]);

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('zv_audit_log')) {
        throw new Error('log sink broken');
      }
    });
    try {
      await runGarbageCollector(asDb(db));
      expect(warn.mock.calls.some((c) => String(c[0]).includes('zv_audit_log purge failed'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
