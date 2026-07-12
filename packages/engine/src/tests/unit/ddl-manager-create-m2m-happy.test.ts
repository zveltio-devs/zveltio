/**
 * DDLManager.createCollection — happy-path m2m junction (ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

const TEXT = { name: 'title', type: 'text', required: true, unique: false, indexed: false };

function setup(existing: string[] = []): CannedDb {
  const db = new CannedDb();
  db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => [
    { exists: existing.includes(String(q.parameters[0])) },
  ]);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.createCollection — m2m happy path', () => {
  it('creates a junction table and registers m2m relation metadata', async () => {
    const db = setup(['zvd_tags']);
    await DDLManager.createCollection(asDb(db), {
      name: 'notes',
      fields: [TEXT, { name: 'tags', type: 'm2m', options: { related_collection: 'tags' } }],
    } as never);

    expect(db.executed(/CREATE TABLE IF NOT EXISTS "zvd_jnc_notes_tags"/)).toHaveLength(1);
    const rel = db.executed(/insert into "zvd_relations"/)[0]!;
    expect(rel.parameters).toContain('m2m');
    expect(rel.parameters).toContain('zvd_jnc_notes_tags');
  });
});
