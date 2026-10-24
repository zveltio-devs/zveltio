/**
 * A column rule changed on another replica drops this replica's readable
 * columns at once, not after the cache's 30 s.
 *
 * The originating replica reseals the collection after the commit and then
 * publishes ACCESS_RULES_CHANGED_EVENT. Only SCHEMA_CHANGED_EVENT dropped the
 * readable-columns cache, so until it expired a replica kept naming the
 * columns of the old seal. The reseal is simulated by changing the grants
 * behind the cache, as the other replica's `zveltio_seal_columns` does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { readableColumns } from '../../db/dynamic.js';
import { DDLManager } from '../../lib/data/index.js';
import { ACCESS_RULES_CHANGED_EVENT, dispatchToWs } from '../../lib/runtime/realtime-bus.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hreadxrep_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;

d('readable columns after a column rule changed on another replica', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'note', type: 'text', required: false, unique: false, indexed: false },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await dropTestCollection(db, COLLECTION);
  });

  it('re-reads the seal once the rule change arrives over the bus', async () => {
    expect(await readableColumns(db, TABLE)).toBeNull();
    await sql`REVOKE SELECT ON ${sql.table(TABLE)} FROM zveltio_rls`.execute(db);
    await sql`GRANT SELECT (id, title) ON ${sql.table(TABLE)} TO zveltio_rls`.execute(db);
    // Cached: this replica has not heard of the change yet.
    expect(await readableColumns(db, TABLE)).toBeNull();

    await dispatchToWs({
      originId: 'eng-elsewhere',
      event: ACCESS_RULES_CHANGED_EVENT,
      collection: '',
      timestamp: new Date().toISOString(),
    });
    expect(await readableColumns(db, TABLE)).toEqual(['id', 'title']);
  }, 30_000);
});
