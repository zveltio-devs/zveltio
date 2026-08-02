/**
 * Administrator-authored validation rules actually reject writes.
 *
 * `zv_validation_rules` had a management UI, an extension, a table and a rule
 * engine, and nothing ever called `validateRecord` — it had zero non-test
 * callers. An admin could write a rule, see it listed as active, and it did
 * nothing. A feature that silently does not run is worse than one that is
 * absent: the absent one does not tell you it is protecting you.
 *
 * `processInput` applies them now, which is the single point the API handlers,
 * import and sync all go through — so these cases check the rule through the
 * HTTP path and then confirm import obeys the same rule, because "the rules
 * only apply on the route someone remembered" is the failure this whole
 * campaign kept finding.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `hvalrule_${STAMP}`;

d('validation rules are enforced on writes', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let ruleId = '';

  const create = (body: unknown) =>
    app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);

    // "score must be at most 100", the kind of thing the UI is for.
    const row = await sql<{ id: string }>`
      INSERT INTO zv_validation_rules
        (collection, field_name, rule_type, rule_config, error_message, is_active)
      VALUES (${COLLECTION}, 'score', 'max',
              ${JSON.stringify({ value: 100 })}::jsonb,
              'Score must be 100 or less', TRUE)
      RETURNING id
    `.execute(db);
    ruleId = row.rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    if (ruleId) {
      await sql`DELETE FROM zv_validation_rules WHERE id = ${ruleId}::uuid`
        .execute(db)
        .catch(() => {});
    }
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('accepts a value the rule allows', async () => {
    const res = await create({ title: 'ok', score: 50 });
    expect(res.status).toBe(201);
  });

  it('rejects a value the rule forbids', async () => {
    // This used to return 201 and store 500.
    const res = await create({ title: 'too big', score: 500 });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail?: string; errors?: unknown };
    expect(JSON.stringify(body)).toMatch(/100 or less/);
  });

  it('does not write the row it rejected', async () => {
    const rows = (await sql
      .raw(`SELECT title FROM "zvd_${COLLECTION}" WHERE title = 'too big'`)
      .execute(db)) as { rows: unknown[] };
    expect(rows.rows.length).toBe(0);
  });

  it('applies to import too, not only the API route', async () => {
    // Import inserts in batches down its own path. Putting the rules in
    // `processInput` is what makes one answer cover both.
    const fd = new FormData();
    fd.set('format', 'csv');
    fd.set('file', new File([`title,score\nviacsv,900\n`], 'r.csv', { type: 'text/csv' }));
    const res = await app.request(`/api/import/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error_rows?: number; success_rows?: number };
    expect(body.error_rows).toBe(1);
    expect(body.success_rows).toBe(0);
  });

  it('ignores a rule that is not active', async () => {
    // What migration 027 relies on: it disables every rule that predates
    // enforcement so an upgrade does not start rejecting writes that have been
    // succeeding for months against rules nobody ever saw run.
    //
    // A NEW collection, because rules are cached for 60s per collection —
    // flipping `is_active` on the rule above would be read from the cache and
    // this test would pass without proving anything.
    const other = `${COLLECTION}_off`;
    await DDLManager.createCollection(db, {
      name: other,
      fields: [{ name: 'score', type: 'number', required: false, unique: false, indexed: false }],
    } as never);
    const row = await sql<{ id: string }>`
      INSERT INTO zv_validation_rules
        (collection, field_name, rule_type, rule_config, error_message, is_active)
      VALUES (${other}, 'score', 'max', ${JSON.stringify({ value: 100 })}::jsonb,
              'Score must be 100 or less', FALSE)
      RETURNING id
    `.execute(db);

    const res = await app.request(`/api/data/${other}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ score: 500 }),
    });
    // 500 breaks the rule; the rule is off, so the write stands.
    expect(res.status).toBe(201);

    await sql`DELETE FROM zv_validation_rules WHERE id = ${row.rows[0]!.id}::uuid`
      .execute(db)
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${other}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', other)
      .execute()
      .catch(() => {});
  });
});
