/**
 * A DDL queue job never runs inside a request's tenant context.
 *
 * The handlers are registered with the request-scoped `db` proxy, which inside
 * a tenant store resolves to that store's transaction. On the pg-driver CI lane
 * a pg-boss worker was caught running its handler inside a request's
 * `withTenantIsolation` store whose transaction had committed long before:
 * every job threw "Transaction is already committed" (add_field even swallowed
 * it and skipped the column), pg-boss retried with backoff, and the request
 * waiting on the job answered 400 after 30 s, for the rest of the run.
 *
 * Here each registered handler is invoked inside such a store, as that worker
 * was. None may touch the dead transaction.
 */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { fieldTypeRegistry } from '../../lib/data/index.js';
import {
  createRequestScopedDb,
  DEFAULT_TENANT_ID,
  runWithTenantTrx,
} from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

type WorkHandler = (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>;
const workHandlers = new Map<string, WorkHandler>();

class FakePgBoss {
  // biome-ignore lint/complexity/noUselessConstructor: types the argument (see ddl-queue-boss-mock.test.ts).
  constructor(_opts: { connectionString: string }) {}
  on() {}
  async start() {}
  async createQueue() {}
  async work(queue: string, handler: WorkHandler) {
    workHandlers.set(queue, handler);
  }
  async stop() {}
}

mock.module('pg-boss', () => ({ PgBoss: FakePgBoss }));

const { initDDLQueue, stopDDLQueue } = await import('../../lib/data/ddl-queue.js');
registerCoreFieldTypes(fieldTypeRegistry);

afterEach(async () => {
  await stopDDLQueue();
  delete process.env.DATABASE_URL;
});

const PAYLOADS: Record<string, unknown> = {
  'ddl.create_collection': { name: 'outside_req', fields: [{ name: 'title', type: 'text' }] },
  'ddl.drop_collection': { name: 'outside_req' },
  'ddl.add_field': { collection: 'outside_req', field: { name: 'note', type: 'text' } },
  'ddl.remove_field': { collection: 'outside_req', fieldName: 'note' },
  'ddl.build_index': {
    ddl: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS zvd_outside_req_note ON zvd_outside_req (note)',
  },
};

describe('DDL queue jobs run outside any request', () => {
  it('no handler reaches a request transaction its worker happens to be resumed in', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    const pool = new CannedDb();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await initDDLQueue(createRequestScopedDb(pool.kysely as unknown as Database));
      expect([...workHandlers.keys()].sort()).toEqual(Object.keys(PAYLOADS).sort());

      for (const [queue, data] of Object.entries(PAYLOADS)) {
        const touched: string[] = [];
        // A request's transaction, committed: any use of it is the defect.
        const committed = new Proxy({} as Database, {
          get(_t, prop) {
            touched.push(String(prop));
            throw new Error('Transaction is already committed');
          },
        });
        await runWithTenantTrx(committed, DEFAULT_TENANT_ID, () =>
          // The canned pool answers what it can; a handler failing on that is
          // not this test's business — reaching the dead transaction is.
          workHandlers.get(queue)!([{ id: `job-${queue}`, data }]).catch(() => {}),
        );
        expect({ queue, touched }).toEqual({ queue, touched: [] });
      }
      // And the work went to the pool instead.
      expect(pool.executed(/zvd_collections|pg_index/).length).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
