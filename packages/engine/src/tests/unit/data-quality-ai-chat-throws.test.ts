/**
 * data-quality.ts — AI normalization pass swallows provider chat failures.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runQualityScan } from '../../lib/data-quality.js';
import { DDLManager } from '../../lib/data/index.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const SCAN_ID = '00000000-0000-4000-8000-00000000a1ce';

function setup(collection: string, fields: unknown[]): CannedDb {
  const db = new CannedDb();
  db.when(/insert into "zv_quality_scans"/, [{ id: SCAN_ID, collection, status: 'running' }]);
  db.when(/select \* from "zvd_collections" where "name" = /, [
    { name: collection, fields: JSON.stringify(fields) },
  ]);
  // The row count has to answer, or the scan aborts before it reaches the AI
  // provider and this file stops testing what its name says. It was unstubbed
  // and the old code turned that into `0` and carried on — so the test passed
  // while exercising a path the product does not take.
  db.when(/SELECT COUNT\(\*\)::text AS count FROM/i, [{ count: '1' }]);
  initTenantManager(db.kysely as unknown as Database);
  return db;
}

async function awaitScanEnd(db: CannedDb) {
  return db.waitFor(/update "zv_quality_scans" set/);
}

beforeEach(() => DDLManager.invalidateCache());

afterEach(() => {
  serviceRegistry.unregisterAs('engine', 'ai.providers');
});

describe('AI normalization — provider failure', () => {
  it('completes without issues when chat throws', async () => {
    const fields = [{ name: 'phone', type: 'text' }];
    const db = setup('contacts', fields);
    db.when(/select \* from "zvd_contacts" limit/, [{ id: 's1', phone: '+1 555' }]);
    serviceRegistry.registerAs('engine', 'ai.providers', {
      getDefault: () => ({
        chat: async () => {
          throw new Error('ai provider offline');
        },
      }),
    });

    await runQualityScan(
      db.kysely as unknown as Database,
      'contacts',
      'normalization',
      'user-1',
      undefined,
      '00000000-0000-0000-0000-0000000000aa',
    );
    const end = await awaitScanEnd(db);

    expect(db.executed(/insert into "zv_quality_issues"/)).toHaveLength(0);
    expect(end.parameters).toContain('completed');
  });
});
