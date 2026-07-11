/**
 * DDLManager.registerMetadata + updateCollectionMetadata (ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.registerMetadata', () => {
  it('inserts collection metadata with ON CONFLICT update', async () => {
    const db = new CannedDb();
    await DDLManager.registerMetadata(asDb(db), {
      name: 'widgets',
      displayName: 'Widgets',
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    expect(db.executed(/insert into "zvd_collections"/i)).toHaveLength(1);
  });
});

describe('DDLManager.updateCollectionMetadata', () => {
  it('patches display_name and invalidates cache', async () => {
    const db = new CannedDb();
    await DDLManager.updateCollectionMetadata(asDb(db), 'widgets', {
      display_name: 'All Widgets',
    });
    expect(db.executed(/update "zvd_collections"/i)).toHaveLength(1);
  });
});
