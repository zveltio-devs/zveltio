/**
 * The query builder is a read path over collection tables, and it was the only
 * one that did not apply column permissions.
 *
 * `/api/data` list, single and bulk, `/api/sync` pull, the realtime fan-out and
 * the relation expander all call `getColumnAccess`. `routes/saved-queries.ts`
 * selected straight from the table, so a `member` with `can_read = false` on a
 * column read that column's values through POST /api/saved-queries/execute —
 * measured against the same user and the same collection that GET /api/data
 * correctly redacted.
 *
 * The suite drives a NON-god session on purpose: god holds
 * `data:view_all_columns`, so a god session cannot observe the restriction at
 * all. That is how the original column-permission suites passed while the
 * masking was broken.
 *
 * Skips without a test database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `qbcol_${Date.now()}`;

d('query builder honours column permissions', () => {
  let app: Hono;
  let db: Database;
  let member: { cookie: string; userId: string };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    await sql
      .raw(
        `INSERT INTO "zvd_${COLLECTION}" (title, salary) VALUES ('a','SECRET-1'),('b','SECRET-2')`,
      )
      .execute(db);
    await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'salary',
        role: 'member',
        can_read: false,
        can_write: false,
      } as never)
      .execute();
    member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zvd_column_permissions')
      .where('collection_name', '=', COLLECTION)
      .execute()
      .catch(() => {});
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

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: member.cookie },
      body: JSON.stringify(body),
    });

  it('GET /api/data redacts the column (the behaviour being matched)', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('SECRET-1');
  });

  it('asking for the hidden column by name does not return it', async () => {
    const res = await post('/api/saved-queries/execute', {
      collection: COLLECTION,
      config: { columns: ['title', 'salary'], limit: 10, page: 1 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('SECRET-1');
    expect(body.records[0]).not.toHaveProperty('salary');
    // The visible column still comes back — the fix must not empty the result.
    expect(body.records[0].title).toBe('a');
  });

  it('asking for no columns at all does not return it either', async () => {
    const res = await post('/api/saved-queries/execute', {
      collection: COLLECTION,
      config: { columns: [], limit: 10, page: 1 },
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain('SECRET-1');
  });

  it('does not publish the hidden value through search_text either', async () => {
    // `search_text` concatenates the record's text fields, so the engine keeps a
    // copy of every hidden column inside a column nobody declared. `/api/data`
    // strips it (lib/data/shape.ts INTERNAL_COLUMNS); this route used to
    // `selectAll()` and returned `"search_text":"a SECRET-1"`.
    const res = await post('/api/saved-queries/execute', {
      collection: COLLECTION,
      config: { columns: [], limit: 10, page: 1 },
    });
    const body = await res.text();
    expect(body).not.toContain('search_text');
    expect(body).not.toContain('search_vector');
    expect(body).not.toContain('SECRET-1');
  });

  it('asking for an internal column by name does not return it', async () => {
    const res = await post('/api/saved-queries/execute', {
      collection: COLLECTION,
      config: { columns: ['title', 'search_text'], limit: 10, page: 1 },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('search_text');
    expect(body).not.toContain('SECRET-1');
  });

  it('filtering on the hidden column is refused, not silently dropped', async () => {
    const res = await post('/api/saved-queries/execute', {
      collection: COLLECTION,
      config: {
        columns: ['title'],
        filters: [{ field: 'salary', operator: 'equals', value: 'SECRET-1' }],
        limit: 10,
        page: 1,
      },
    });
    expect(res.status).toBe(403);
  });

  it('sorting by the hidden column is refused', async () => {
    const res = await post('/api/saved-queries/execute', {
      collection: COLLECTION,
      config: {
        columns: ['title'],
        sorts: [{ field: 'salary', direction: 'desc' }],
        limit: 10,
        page: 1,
      },
    });
    expect(res.status).toBe(403);
  });

  it('a saved query run by the same user is subject to the same masking', async () => {
    const saved = await post('/api/saved-queries', {
      name: 'qb-colperm',
      collection: COLLECTION,
      config: { columns: ['title', 'salary'], limit: 10, page: 1 },
    });
    expect(saved.status).toBe(201);
    const { id } = await saved.json();
    const run = await post(`/api/saved-queries/${id}/run`, {});
    expect(run.status).toBe(200);
    expect(JSON.stringify(await run.json())).not.toContain('SECRET-1');
  });

  it('caps and types the run override instead of handing it to Postgres', async () => {
    const saved = await post('/api/saved-queries', {
      name: 'qb-override',
      collection: COLLECTION,
      config: { columns: ['title'], limit: 10, page: 1 },
    });
    const { id } = await saved.json();
    for (const override of [{ limit: 5_000_000 }, { page: -5 }, { limit: 'abc' }]) {
      const res = await post(`/api/saved-queries/${id}/run`, override);
      expect(res.status).toBe(400);
    }
    // A legitimate override still works.
    const ok = await post(`/api/saved-queries/${id}/run`, { limit: 1, page: 2 });
    expect(ok.status).toBe(200);
  });

  it('refuses an operator neither applier understands, in both filter modes', async () => {
    for (const filter_mode of ['AND', 'OR'] as const) {
      const res = await post('/api/saved-queries/execute', {
        collection: COLLECTION,
        config: {
          columns: ['title'],
          filter_mode,
          filters: [{ field: 'title', operator: 'regex_match', value: '.*' }],
          limit: 10,
          page: 1,
        },
      });
      expect(res.status).toBe(400);
    }
  });
});
