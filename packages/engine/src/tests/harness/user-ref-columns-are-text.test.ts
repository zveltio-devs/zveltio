/**
 * Gate — no uuid column may be named `*_by`.
 *
 * `"user".id` is a 32-character nanoid and always was. A column named
 * `created_by` or `checked_by` reads like a foreign key to a table whose primary
 * key happens to be a uuid, so eleven of them across the engine and eight
 * extensions were declared UUID. Postgres answers 22P02 to every write, which
 * the routes surfaced as a 400 or a 500 naming nothing useful.
 *
 * The features that never worked because of it: creating a document, creating a
 * purchase order, creating an edge function, saving a page revision, resolving a
 * recall, approving a payroll period — and ticking an item off a checklist,
 * which is the entire point of a checklist.
 *
 * This exists because the first two sweeps did not find them all. Both worked
 * from a hand-written list of column names, and a list is only as good as
 * whoever wrote it: `checked_by` was simply never thought of, so the most-used
 * write in the checklists extension stayed broken through two passes that were
 * explicitly looking for this exact bug.
 *
 * Asking the catalogue removes the guessing. The suffix is the whole rule — if
 * a column records WHO did something, it holds a user id, and a user id is text.
 *
 * Deliberately not narrowed to columns something writes today. An unwritten
 * `*_by` is a trap set for whoever adds the route: it fails on their first
 * attempt, in a cast error that names the type and not the cause.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('user reference columns (in-process)', () => {
  it('no uuid column is named *_by', async () => {
    const { db }: { db: Database } = await getTestApp();

    const res = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type = 'uuid'
         AND column_name ~ '_by$'
       ORDER BY table_name, column_name
    `.execute(db);

    expect(
      res.rows.map((r) => `${r.table_name}.${r.column_name}`),
      'a column recording WHO did something holds a user id, and "user".id is a ' +
        '32-character nanoid — uuid rejects it with 22P02 on the first write',
    ).toEqual([]);
  });
});
