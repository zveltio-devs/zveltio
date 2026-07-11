/**
 * DDLManager metadata cache (lib/data/ddl-manager.ts) — getCollections/getCollection TTL.
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

describe('DDLManager metadata cache', () => {
  it('getCollections caches the list and skips a second DB round-trip', async () => {
    const db = new CannedDb();
    let hits = 0;
    db.when(/from "zvd_collections"/i, () => {
      hits++;
      return [{ name: 'articles', fields: '[]', sort: 1 }];
    });
    const first = await DDLManager.getCollections(asDb(db));
    const second = await DDLManager.getCollections(asDb(db));
    expect(first).toHaveLength(1);
    expect(second[0]?.name).toBe('articles');
    expect(hits).toBe(1);
  });

  it('getCollection parses string fields and caches per name', async () => {
    const db = new CannedDb();
    let hits = 0;
    db.when(/select \* from "zvd_collections" where "name" = /i, () => {
      hits++;
      return [
        {
          name: 'widgets',
          fields: JSON.stringify([{ name: 'title', type: 'text' }]),
        },
      ];
    });
    const row = await DDLManager.getCollection(asDb(db), 'widgets');
    expect(row?.fields?.[0]?.name).toBe('title');
    await DDLManager.getCollection(asDb(db), 'widgets');
    expect(hits).toBe(1);
  });

  it('invalidateCache forces a fresh load', async () => {
    const db = new CannedDb();
    let hits = 0;
    db.when(/from "zvd_collections"/i, () => {
      hits++;
      return [{ name: 'a', fields: '[]', sort: 1 }];
    });
    await DDLManager.getCollections(asDb(db));
    DDLManager.invalidateCache();
    await DDLManager.getCollections(asDb(db));
    expect(hits).toBe(2);
  });
});
