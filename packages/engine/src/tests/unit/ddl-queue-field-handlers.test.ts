/**
 * ddl-queue add_field / remove_field work handlers (mocked pg-boss + DDLManager).
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import * as dataModule from '../../lib/data/index.js';
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

function setupDb(): CannedDb {
  const db = new CannedDb();
  db.when(/select "is_managed" from "zvd_collections"/i, [{ is_managed: true }]);
  return db;
}

beforeEach(() => {
  workHandlers.clear();
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
});

afterEach(async () => {
  await stopDDLQueue();
  delete process.env.DATABASE_URL;
});

describe('ddl-queue field handlers', () => {
  it('add_field handler delegates to DDLManager.addField', async () => {
    const addSpy = spyOn(dataModule.DDLManager, 'addField').mockResolvedValue(undefined);
    try {
      const db = setupDb();
      await initDDLQueue(asDb(db));
      const handler = workHandlers.get('ddl.add_field');
      await handler!([
        {
          id: 'j-add',
          data: {
            collection: 'articles',
            field: {
              name: 'subtitle',
              type: 'text',
              required: false,
              unique: false,
              indexed: false,
            },
          },
        },
      ]);
      expect(addSpy).toHaveBeenCalled();
    } finally {
      addSpy.mockRestore();
    }
  });

  it('remove_field handler delegates to DDLManager.removeField', async () => {
    const rmSpy = spyOn(dataModule.DDLManager, 'removeField').mockResolvedValue(undefined);
    try {
      const db = setupDb();
      await initDDLQueue(asDb(db));
      const handler = workHandlers.get('ddl.remove_field');
      await handler!([{ id: 'j-rm', data: { collection: 'articles', fieldName: 'subtitle' } }]);
      expect(rmSpy).toHaveBeenCalledWith(expect.anything(), 'articles', 'subtitle');
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('add_field skips BYOD collections (is_managed=false)', async () => {
    const addSpy = spyOn(dataModule.DDLManager, 'addField').mockResolvedValue(undefined);
    try {
      const db = setupDb();
      db.when(/select "is_managed" from "zvd_collections"/i, [{ is_managed: false }]);
      await initDDLQueue(asDb(db));
      const handler = workHandlers.get('ddl.add_field');
      await handler!([
        {
          id: 'j-byod',
          data: {
            collection: 'articles',
            field: { name: 'x', type: 'text', required: false, unique: false, indexed: false },
          },
        },
      ]);
      expect(addSpy).not.toHaveBeenCalled();
    } finally {
      addSpy.mockRestore();
    }
  });
});
