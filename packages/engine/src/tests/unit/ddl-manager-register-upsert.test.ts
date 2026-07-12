/**
 * DDLManager.registerMetadata — ON CONFLICT DO UPDATE path (ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

const TEXT = { name: 'title', type: 'text', required: true, unique: false, indexed: false };

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.registerMetadata — upsert', () => {
  it('updates display_name and fields on name conflict', async () => {
    const db = new CannedDb();
    await DDLManager.registerMetadata(asDb(db), {
      name: 'catalog',
      displayName: 'Catalog v1',
      routeGroup: 'public',
      isPermissioned: false,
      schemaLocked: true,
      sort: 10,
      fields: [TEXT],
    } as never);

    await DDLManager.registerMetadata(asDb(db), {
      name: 'catalog',
      displayName: 'Catalog v2',
      fields: [{ name: 'sku', type: 'text', required: false, unique: false, indexed: false }],
    } as never);

    const upserts = db.executed(/insert into "zvd_collections"/i);
    expect(upserts).toHaveLength(2);
    expect(upserts[1]!.sql).toMatch(/do update set/i);
    expect(upserts[0]!.parameters).toContain('public');
    expect(upserts[0]!.parameters).toContain(false);
    expect(upserts[1]!.parameters).toContain('Catalog v2');
  });
});
