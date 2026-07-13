/**
 * getDb / dynamicDb helpers (write-pipeline.ts).
 */

import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import { dynamicDb, getDb } from '../../lib/data/write-pipeline.js';

describe('getDb — pool fallback', () => {
  it('returns the pool executor when tenantTrx is absent', () => {
    const pool = { tag: 'pool' } as unknown as Database;
    const c = { get: () => undefined } as unknown as Context;
    expect(getDb(c, pool)).toBe(pool);
  });
});

describe('dynamicDb', () => {
  it('casts a Database to DynamicDB for runtime table access', () => {
    const db = { selectFrom: () => 'qb' } as unknown as Database;
    const dyn = dynamicDb(db);
    expect(dyn).toBe(db);
  });
});
