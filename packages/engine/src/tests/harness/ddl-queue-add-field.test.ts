/**
 * The DDL queue's add_field job on real Postgres (lib/data/ddl-queue.ts).
 *
 * The handler ran DDLManager.addField inside a transaction, and addField builds
 * a field's indexes CONCURRENTLY — which Postgres refuses in a transaction
 * block. Every indexed field failed with 25001, pg-boss retried the same
 * failure, and the column never appeared. The mocked queue tests could not see
 * it: the refusal comes from Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, enqueueDDLJob, getDDLJob } from '../../lib/data/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hqaf_${Date.now()}`;

d('DDL queue add_field (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'n', type: 'integer', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('adds an indexed field, with its indexes', async () => {
    const id = await enqueueDDLJob(db, 'add_field', {
      collection: COLLECTION,
      field: { name: 'rank', type: 'integer', required: false, unique: false, indexed: true },
    });
    const job = await getDDLJob(db, id);
    expect({ status: job?.status, error: job?.error ?? null }).toEqual({
      status: 'completed',
      error: null,
    });
    const idx = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE tablename = ${`zvd_${COLLECTION}`} AND indexdef LIKE '%(rank)%'
    `.execute(db);
    expect(idx.rows[0]?.n).toBeGreaterThanOrEqual(1);
    // pg-boss polls for work; the job settles within a few seconds.
  }, 30_000);
});
