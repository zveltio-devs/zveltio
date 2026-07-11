/**
 * applyExpand DB path (lib/data/shape.ts) — hydrates m2o/reference relations.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { applyExpand, resolveExpand } from '../../lib/data/shape.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

const COLLECTION = {
  fields: [
    { name: 'owner', type: 'm2o', options: { related_collection: 'users' } },
    { name: 'title', type: 'text' },
  ],
};

describe('applyExpand', () => {
  it('hydrates referenced rows with _label from name/title/email fallbacks', async () => {
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'users',
        fields: JSON.stringify([{ name: 'email', type: 'email' }]),
      },
    ]);
    db.when(/SELECT \* FROM "zvd_users"/i, [
      { id: 'u-1', email: 'alice@example.com' },
      { id: 'u-2', title: 'Bob Title' },
    ]);

    const records = [
      { id: 'r-1', owner: 'u-1', title: 'A' },
      { id: 'r-2', owner: 'u-2', title: 'B' },
      { id: 'r-3', owner: null, title: 'C' },
    ] as Record<string, unknown>[];

    const plan = await resolveExpand(asDb(db), COLLECTION as never, 'owner');
    await applyExpand(asDb(db), records as never, plan);

    expect(records[0]!.owner_expanded).toMatchObject({
      id: 'u-1',
      _label: 'alice@example.com',
    });
    expect(records[1]!.owner_expanded).toMatchObject({
      id: 'u-2',
      _label: 'Bob Title',
    });
    expect(records[2]).not.toHaveProperty('owner_expanded');
  });

  it('skips expand when no ids are present on records', async () => {
    const db = new CannedDb();
    const records = [{ id: 'r-1', owner: null }] as Record<string, unknown>[];
    const plan = await resolveExpand(asDb(db), COLLECTION as never, 'owner');
    await applyExpand(asDb(db), records as never, plan);
    expect(db.executed(/SELECT \* FROM "zvd_users"/i)).toHaveLength(0);
  });
});
