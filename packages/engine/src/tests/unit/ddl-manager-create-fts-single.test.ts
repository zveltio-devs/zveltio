/**
 * DDLManager.createCollection — single text-field FTS branch (ddl-manager.ts).
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

describe('DDLManager.createCollection — single-text FTS', () => {
  it('uses coalesce (not concat_ws) when only one searchable text field exists', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: false }]);

    await DDLManager.createCollection(asDb(db), {
      name: 'solo_text',
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    const trigger = db.executed(/zvd_solo_text_search_trigger/)[0]!;
    expect(trigger.sql).toContain('coalesce(NEW."title", \'\')');
    expect(trigger.sql).not.toContain('concat_ws');
    expect(trigger.sql).toContain('setweight');
    expect(trigger.sql).toContain("'A'");
    expect(db.executed(/has_trgm/)).toHaveLength(1);
  });
});
