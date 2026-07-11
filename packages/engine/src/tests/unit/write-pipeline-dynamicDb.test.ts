/**
 * dynamicDb type escape hatch (lib/data/write-pipeline.ts).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { dynamicDb } from '../../lib/data/write-pipeline.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('dynamicDb', () => {
  it('returns the same database handle cast for dynamic table access', () => {
    const db = new CannedDb().kysely as unknown as Database;
    const dyn = dynamicDb(db);
    expect(dyn).toBe(db);
    expect(typeof dyn.selectFrom).toBe('function');
  });
});
