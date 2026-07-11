/**
 * Tenant schema provisioning (lib/tenancy/tenant-manager.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  initTenantManager,
  provisionEnvironment,
  provisionTenantSchema,
} from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const TENANT_ID = 'aaaaaaaa-0000-4000-8000-000000000099';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('provisionTenantSchema', () => {
  it('creates the schema and core metadata tables', async () => {
    const db = new CannedDb();
    initTenantManager(asDb(db));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await provisionTenantSchema('tenant_acme');
      expect(db.executed(/CREATE SCHEMA IF NOT EXISTS "tenant_acme"/)).toHaveLength(1);
      expect(db.executed(/tenant_acme.*zvd_collections/)).toHaveLength(1);
      expect(db.executed(/tenant_acme.*zvd_relations/)).toHaveLength(1);
      expect(db.executed(/tenant_acme.*zvd_permissions/)).toHaveLength(1);
      expect(log.mock.calls.some((c) => String(c[0]).includes('Tenant schema provisioned'))).toBe(
        true,
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('provisionEnvironment', () => {
  it('registers a colored environment row after provisioning the schema', async () => {
    const db = new CannedDb();
    initTenantManager(asDb(db));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await provisionEnvironment(TENANT_ID, 'acme', 'staging', 'Staging', false);
      expect(db.executed(/CREATE SCHEMA IF NOT EXISTS "tenant_acme_staging"/)).toHaveLength(1);
      const insert = db.executed(/insert into "zv_environments"/i)[0];
      expect(insert).toBeDefined();
      expect(insert?.parameters).toContain('staging');
      expect(insert?.parameters).toContain('#d97706');
    } finally {
      log.mockRestore();
    }
  });
});
