// `DDLManager.columnNames`: every physical column of a collection's table,
// system columns included — what an extension checks a name against now that
// `ctx.db` refuses `information_schema` to it (#858). `introspectTable` answers
// only the user fields, so a page filtering on `status` or addressing a record
// by `id` had no engine helper that knew those columns exist.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `colnames_${String(Date.now()).slice(-6)}`;

d('DDLManager.columnNames (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: NAME,
      fields: [{ name: 'slug', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, NAME).catch(() => {});
  });

  it('lists the user fields and the system columns, in table order', async () => {
    const cols = await DDLManager.columnNames(db, NAME);
    expect(cols[0]).toBe('id');
    expect(cols).toContain('slug');
    expect(cols).toContain('status');
    expect(cols).toContain('created_at');
    // What introspectTable leaves out is exactly what this adds.
    const fields = (await DDLManager.introspectTable(db, NAME)).map((f) => f.name);
    expect(fields).not.toContain('id');
  });

  it('answers [] for a collection with no table', async () => {
    expect(await DDLManager.columnNames(db, `${NAME}_missing`)).toEqual([]);
  });
});
