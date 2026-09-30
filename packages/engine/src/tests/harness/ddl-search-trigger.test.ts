/**
 * A collection's full-text search trigger on real Postgres
 * (lib/data/ddl-manager.ts — refreshSearchTrigger).
 *
 * The trigger used to name each text field as `NEW."field"`, written once at
 * create. Removing or renaming a text field — removeField, the field routes, a
 * schema-branch merge — left it naming a column that no longer existed, and
 * every INSERT and UPDATE on the collection failed with `record "new" has no
 * field`. A text field added later was never searchable, and a collection
 * created without one never got search_text at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const MAIN = `hsrch_${SFX}`;
const BARE = `hsrchb_${SFX}`;
const OLD = `hsrcho_${SFX}`;

const text = (name: string, type = 'text') => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
});

d('collection search trigger (in-process)', () => {
  let db: Database;

  const insert = (c: string, row: Record<string, string>) =>
    sql<{ search_text: string | null; search_vector: string | null }>`
      INSERT INTO ${sql.id(`zvd_${c}`)} (${sql.join(Object.keys(row).map((k) => sql.id(k)))})
      VALUES (${sql.join(Object.values(row))})
      RETURNING search_text, search_vector::text AS search_vector
    `
      .execute(db)
      .then((r) => r.rows[0]!);

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  afterAll(async () => {
    if (!db) return;
    for (const c of [MAIN, BARE, OLD]) await dropTestCollection(db, c).catch(() => {});
  });

  it('weights the text fields in order and fills search_text', async () => {
    await DDLManager.createCollection(db, {
      name: MAIN,
      fields: [
        text('title'),
        text('body', 'richtext'),
        text('mail', 'email'),
        text('extra'),
        text('tail'),
        { ...text('qty'), type: 'integer' },
      ],
    } as never);
    const row = await insert(MAIN, {
      title: 'alpha',
      body: 'bravo',
      mail: 'charlie',
      extra: 'delta',
      tail: 'echo',
    });
    expect(row.search_vector).toBe("'alpha':1A 'bravo':2B 'charli':3C 'delta':4 'echo':5");
    expect(row.search_text).toBe('alpha bravo charlie delta echo');
    const meta = await db
      .selectFrom('zvd_collections')
      .select('has_trgm')
      .where('name', '=', MAIN)
      .executeTakeFirstOrThrow();
    expect(meta.has_trgm).toBe(true);
  });

  it('keeps the collection writable after a text field is removed or renamed', async () => {
    await DDLManager.removeField(db, MAIN, 'body');
    expect((await insert(MAIN, { title: 'after', extra: 'remove' })).search_text).toBe(
      'after remove',
    );

    // A rename that bypasses the metadata, as a hand-run ALTER would.
    await sql`ALTER TABLE ${sql.id(`zvd_${MAIN}`)} RENAME COLUMN extra TO extra2`.execute(db);
    expect((await insert(MAIN, { title: 'still' })).search_text).toBe('still');
  });

  it('makes a text field added later searchable, even on a collection that had none', async () => {
    await DDLManager.createCollection(db, {
      name: BARE,
      fields: [{ ...text('qty'), type: 'integer' }],
    } as never);
    await DDLManager.addField(db, BARE, text('label') as never);
    expect((await insert(BARE, { label: 'findme' })).search_text).toBe('findme');
    const meta = await db
      .selectFrom('zvd_collections')
      .select('has_trgm')
      .where('name', '=', BARE)
      .executeTakeFirstOrThrow();
    expect(meta.has_trgm).toBe(true);
  });

  it('boot reconcile rewrites a collection that is already unwritable, then leaves it alone', async () => {
    await DDLManager.createCollection(db, {
      name: OLD,
      fields: [text('title'), text('gone')],
    } as never);
    const table = `zvd_${OLD}`;
    // The trigger as collections created before this change carry it.
    await sql
      .raw(
        `CREATE OR REPLACE FUNCTION ${table}_search_trigger() RETURNS trigger AS $$ BEGIN ` +
          `NEW.search_vector := to_tsvector('english', coalesce(NEW."title", '') || coalesce(NEW."gone", '')); ` +
          `NEW.search_text := concat_ws(' ', NEW."title", NEW."gone"); RETURN NEW; END $$ LANGUAGE plpgsql`,
      )
      .execute(db);
    await sql.raw(`ALTER TABLE ${table} DROP COLUMN gone`).execute(db);
    await expect(insert(OLD, { title: 'x' })).rejects.toThrow(/has no field/);

    expect(await DDLManager.reconcileSearchTriggers(db)).toBeGreaterThanOrEqual(1);
    expect((await insert(OLD, { title: 'fixed' })).search_text).toBe('fixed');
    // Settled: a second pass rewrites none of these three.
    for (const c of [MAIN, BARE, OLD]) {
      expect(await DDLManager.refreshSearchTrigger(db, c)).toBe(false);
    }
  });
});
