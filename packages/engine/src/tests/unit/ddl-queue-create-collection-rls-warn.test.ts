/**
 * ddl-queue create_collection handler — applyTenantRLS failure is non-fatal (ddl-queue.ts).
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import * as dataModule from '../../lib/data/index.js';
import * as tenantModule from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

type WorkHandler = (jobs: Array<{ id: string; data: unknown }>) => Promise<void>;

const workHandlers = new Map<string, WorkHandler>();

class FakePgBoss {
  constructor(_opts: { connectionString: string }) {}
  on() {}
  async start() {}
  async createQueue() {}
  async work(queue: string, handler: WorkHandler) {
    workHandlers.set(queue, handler);
  }
  async send() {
    return 'job-1';
  }
  async getJobById() {
    return { state: 'completed' };
  }
  async stop() {}
}

mock.module('pg-boss', () => ({ PgBoss: FakePgBoss }));

const { initDDLQueue, stopDDLQueue } = await import('../../lib/data/ddl-queue.js');

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  workHandlers.clear();
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
});

afterEach(async () => {
  await stopDDLQueue();
  delete process.env.DATABASE_URL;
});

describe('ddl-queue create_collection RLS tolerance', () => {
  it('warns and still completes when applyTenantRLS throws', async () => {
    const createSpy = spyOn(dataModule.DDLManager, 'createCollection').mockResolvedValue(undefined);
    const rlsSpy = spyOn(tenantModule, 'applyTenantRLS').mockRejectedValue(new Error('rls boom'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = new CannedDb();
      await initDDLQueue(asDb(db));
      const handler = workHandlers.get('ddl.create_collection');
      await handler!([
        {
          id: 'j-rls',
          data: {
            name: 'catalog',
            fields: [
              { name: 'title', type: 'text', required: true, unique: false, indexed: false },
            ],
          },
        },
      ]);
      expect(createSpy).toHaveBeenCalled();
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('applyTenantRLS on create_collection')),
      ).toBe(true);
    } finally {
      createSpy.mockRestore();
      rlsSpy.mockRestore();
      warn.mockRestore();
    }
  });
});
