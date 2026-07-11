/**
 * DDLManager createCollection — diverse field types (lib/data/ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

function setup(): CannedDb {
  const db = new CannedDb();
  db.when(/SELECT EXISTS[\s\S]*pg_tables/i, () => [{ exists: false }]);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('createCollection — typed columns', () => {
  it('emits boolean, json, date, and uuid column DDL', async () => {
    const db = setup();
    await DDLManager.createCollection(asDb(db), {
      name: 'typed',
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'active', type: 'boolean', required: false, unique: false, indexed: false },
        { name: 'meta', type: 'json', required: false, unique: false, indexed: false },
        { name: 'born_on', type: 'date', required: false, unique: false, indexed: false },
        { name: 'external_id', type: 'uuid', required: false, unique: false, indexed: false },
      ],
    } as never);

    const create = db.executed(/CREATE TABLE zvd_typed/)[0]!;
    expect(create.sql).toContain('"active"');
    expect(create.sql).toContain('"meta"');
    expect(create.sql).toContain('"born_on"');
    expect(create.sql).toContain('"external_id"');
    expect(db.executed(/insert into "zvd_collections"/)).toHaveLength(1);
  });

  it('creates encrypted text columns when the field is flagged', async () => {
    const db = setup();
    await DDLManager.createCollection(asDb(db), {
      name: 'secrets',
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        {
          name: 'api_key',
          type: 'text',
          required: false,
          unique: false,
          indexed: false,
          encrypted: true,
        },
      ],
    } as never);
    const create = db.executed(/CREATE TABLE zvd_secrets/)[0]!;
    expect(create.sql).toContain('"api_key"');
  });
});
