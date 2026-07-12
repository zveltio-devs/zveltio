/**
 * ddl-queue — pg-boss 'error' event handler logs non-fatally.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

let capturedErrorHandler: ((err: Error) => void) | undefined;

class FakePgBoss {
  constructor(_opts: { connectionString: string }) {}

  on(event: string, cb: (err: Error) => void) {
    if (event === 'error') capturedErrorHandler = cb;
  }

  async start() {}
  async createQueue() {}
  async work() {}
  async stop() {}
}

mock.module('pg-boss', () => ({ PgBoss: FakePgBoss }));

const { initDDLQueue, stopDDLQueue } = await import('../../lib/data/ddl-queue.js');

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  capturedErrorHandler = undefined;
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
});

afterEach(async () => {
  await stopDDLQueue();
  delete process.env.DATABASE_URL;
});

describe('ddl-queue pg-boss error handler', () => {
  it('forwards boss errors to console.warn', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const db = new CannedDb();
      db.when(/pg_stat_user_indexes/i, []);
      await initDDLQueue(asDb(db));
      expect(capturedErrorHandler).toBeDefined();
      capturedErrorHandler!(new Error('connection reset'));
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[ddl-queue] pg-boss error'))).toBe(
        true,
      );
      expect(warn.mock.calls.some((c) => String(c[1]).includes('connection reset'))).toBe(true);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
