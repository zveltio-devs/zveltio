/**
 * Environment provisioning (lib/tenancy/tenant-manager.ts).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { initTenantManager, provisionEnvironment } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const TENANT_ID = 'aaaaaaaa-0000-4000-8000-000000000099';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('provisionEnvironment', () => {
  it('registers a colored environment row and creates no schema', async () => {
    const db = new CannedDb();
    initTenantManager(asDb(db));
    await provisionEnvironment(TENANT_ID, 'staging', 'Staging', false);
    expect(db.executed(/CREATE SCHEMA/i)).toHaveLength(0);
    const insert = db.executed(/insert into "zv_environments"/i)[0];
    expect(insert).toBeDefined();
    expect(insert?.sql).not.toContain('schema_name');
    expect(insert?.parameters).toContain('staging');
    expect(insert?.parameters).toContain('#d97706');
  });
});
