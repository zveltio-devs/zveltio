/**
 * Two DDL-manager defects (review A13):
 *
 * - Two m2m relations between one pair (`posts.tags`, `posts.featured`) were
 *   both given `zvd_jnc_<posts>_<tags>`: their links were one set, and removing
 *   either relation dropped the table the other still named.
 * - POST /api/collections registers the `zvd_collections` row before it queues
 *   the create job. A job that failed for good left the row with no table:
 *   listed, holding the name (409), and refused by DELETE as "not found".
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, runCreateCollection } from '../../lib/data/index.js';
import { createRelation } from '../../lib/data/relations.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const S = Date.now();
const POSTS = `jp_${S}`;
const TAGS = `jt_${S}`;
const FAILED = `jf_${S}`;
const STRANDED = `js_${S}`;
const SIDE = `jd_${S}`;
const LINKS = `jl_${S}`;

d('m2m junctions and failed-create rows', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const exists = async (table: string) =>
    (await sql<{ t: string | null }>`SELECT to_regclass(${table})::text AS t`.execute(db)).rows[0]
      ?.t != null;
  const row = async (name: string) =>
    (await sql`SELECT 1 FROM zvd_collections WHERE name = ${name}`.execute(db)).rows.length;
  const m2m = (name: string, field: string) =>
    createRelation(db, {
      name,
      type: 'm2m',
      source_collection: POSTS,
      source_field: field,
      target_collection: TAGS,
      on_delete: 'SET NULL',
      on_update: 'CASCADE',
      metadata: {},
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, { name: TAGS, fields: [{ name: 'n', type: 'text' }] });
    await DDLManager.createCollection(db, { name: POSTS, fields: [{ name: 't', type: 'text' }] });
  });

  afterAll(async () => {
    if (!db) return;
    for (const n of [POSTS, TAGS, FAILED, STRANDED, LINKS, SIDE]) {
      await DDLManager.dropCollection(db, n, { force: true }).catch(() => {});
    }
  });

  it('two m2m between one pair get a junction each; removing one keeps the other', async () => {
    const tags = await m2m(`${POSTS}_tags`, 'tags');
    const featured = await m2m(`${POSTS}_featured`, 'featured');
    expect(featured!.junction_table).not.toBe(tags!.junction_table);

    const j = tags!.junction_table as string;
    const tag = await sql<{ id: string }>`
      INSERT INTO ${sql.id(`zvd_${TAGS}`)} (n) VALUES ('x') RETURNING id`.execute(db);
    const post = await sql<{ id: string }>`
      INSERT INTO ${sql.id(`zvd_${POSTS}`)} (t) VALUES ('p') RETURNING id`.execute(db);
    await sql`INSERT INTO ${sql.id(j)} (${sql.id(`${POSTS}_id`)}, ${sql.id(`${TAGS}_id`)})
              VALUES (${post.rows[0]!.id}, ${tag.rows[0]!.id})`.execute(db);

    const res = await app.request(`/api/relations/${featured!.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await exists(featured!.junction_table as string)).toBe(false);
    const links = await sql`SELECT 1 FROM ${sql.id(j)}`.execute(db);
    expect(links.rows.length).toBe(1);
  });

  it('a junction another relation still names is not dropped', async () => {
    // A table two relations already share (made before the fix).
    const tags = await sql<{ junction_table: string }>`
      SELECT junction_table FROM zvd_relations
       WHERE source_collection = ${POSTS} AND source_field = 'tags'`.execute(db);
    const j = tags.rows[0]!.junction_table;
    await sql`INSERT INTO zvd_relations (name, type, source_collection, source_field,
                target_collection, target_field, junction_table)
              VALUES (${`${POSTS}_legacy`}, 'm2m', ${POSTS}, 'legacy', ${TAGS}, 'id', ${j})`.execute(
      db,
    );
    await db.transaction().execute((trx) => DDLManager.dropJunctionTable(trx, j));
    expect(await exists(j)).toBe(true);
    await sql`DELETE FROM zvd_relations WHERE name = ${`${POSTS}_legacy`}`.execute(db);
  });

  it("dropping a collection leaves an extension's own junction table (a collection) standing", async () => {
    await DDLManager.createCollection(db, { name: SIDE, fields: [{ name: 'n', type: 'text' }] });
    await DDLManager.createCollection(db, { name: LINKS, fields: [{ name: 'n', type: 'text' }] });
    // An m2m that joins through a table of its own, as crm's contact_organizations does.
    await sql`INSERT INTO zvd_relations (name, type, source_collection, source_field,
                target_collection, target_field, junction_table)
              VALUES (${`${LINKS}_rel`}, 'm2m', ${LINKS}, 'sides', ${SIDE}, 'id', ${`zvd_${LINKS}`})`.execute(
      db,
    );
    await DDLManager.dropCollection(db, SIDE);
    expect(await exists(`zvd_${LINKS}`)).toBe(true);
    expect(await row(LINKS)).toBe(1);
  });

  it('a create that fails takes the row POST registered with it', async () => {
    // What POST /api/collections does before it queues the job.
    await DDLManager.registerMetadata(db, {
      name: FAILED,
      fields: [{ name: 'x', type: 'text' }],
    } as never);
    // Two columns of one name: CREATE TABLE refuses it, on every retry.
    const failed = await runCreateCollection(db, {
      name: FAILED,
      fields: [
        { name: 'x', type: 'text' },
        { name: 'x', type: 'text' },
      ],
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(await row(FAILED)).toBe(0);
  });

  it('DELETE removes a row left with no table', async () => {
    await DDLManager.registerMetadata(db, {
      name: STRANDED,
      fields: [{ name: 'x', type: 'text' }],
    } as never);
    const res = await app.request(`/api/collections/${STRANDED}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await row(STRANDED)).toBe(0);
  });
});
