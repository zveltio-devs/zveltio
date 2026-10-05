/**
 * Schema as code, acceptance (docs/engine/rfc-schema-as-code.md §9.1, §9.2).
 *
 * An instance with collections, every relation kind, an index, a row rule, a
 * column permission, a validation rule and a custom role — built through the
 * routes, the way an administrator builds one. `pull` it, take it all away,
 * `apply` the files: the installed schema (`renderInstalledSchema`, the
 * snapshot gate's own reader, plus every index) is what it was, and a second
 * `pull` gives the same bytes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { renderInstalledSchema } from '../../db/installed-schema.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const AUTHOR = 'acc_author';
const POST = 'acc_post';
const TAG = 'acc_tag';
const ROLE = 'acc_role';
const MINE = /acc_/;

d('schema as code acceptance', () => {
  let app: Hono;
  let db: Database;
  let raw: SQL;
  let cookie: string;

  const send = async (method: string, path: string, body: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res;
  };

  const pull = async () => {
    const res = await app.request('/api/admin/schema/export', { headers: { cookie } });
    return ((await res.json()) as { files: Record<string, string> }).files;
  };

  /** The fixture's part of the installed schema, plus every index on it. */
  const snapshot = async () => {
    const blocks = (await renderInstalledSchema(raw))
      .split('\n\n')
      .filter((b) => MINE.test(b.split('\n')[0]));
    const idx = await raw`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename LIKE ${'%acc_%'} ORDER BY indexname`;
    return [...blocks, ...idx.map((i: { indexdef: string }) => i.indexdef)].join('\n');
  };

  const teardown = async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE} OR v2 LIKE ${'acc_%'}`.execute(db);
    await sql`DELETE FROM zv_roles WHERE name = ${ROLE}`.execute(db);
    await sql`DELETE FROM zvd_rls_policies WHERE collection LIKE ${'acc_%'}`.execute(db);
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name LIKE ${'acc_%'}`.execute(db);
    await sql`DELETE FROM zv_validation_rules WHERE collection LIKE ${'acc_%'}`.execute(db);
    await sql`DELETE FROM zvd_relations WHERE source_collection LIKE ${'acc_%'}`.execute(db);
    await sql`DROP TABLE IF EXISTS zvd_jnc_acc_post_acc_tag CASCADE`.execute(db);
    for (const c of [POST, TAG, AUTHOR]) await dropTestCollection(db, c);
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    raw = new SQL(process.env.TEST_DATABASE_URL as string);
    cookie = await createGodSession(app, db);
    await teardown();

    await send('POST', '/api/collections', {
      name: AUTHOR,
      displayName: 'Authors',
      fields: [{ name: 'name', type: 'text', required: true, label: 'Name' }],
    });
    await send('POST', '/api/collections', {
      name: TAG,
      fields: [{ name: 'label', type: 'text' }],
    });
    await send('POST', '/api/collections', {
      name: POST,
      fields: [
        { name: 'title', type: 'text', indexed: true },
        { name: 'author', type: 'm2o', label: 'Author', options: { related_collection: AUTHOR } },
      ],
    });
    // Created after `author`, so the plan must reorder to put it first.
    await send('POST', '/api/relations', {
      name: 'acc_author_posts',
      type: 'o2m',
      source_collection: AUTHOR,
      source_field: 'posts',
      target_collection: POST,
      target_field: 'writer',
      on_delete: 'CASCADE',
    });
    await send('POST', '/api/relations', {
      name: 'acc_post_tags',
      type: 'm2m',
      source_collection: POST,
      source_field: 'tags',
      target_collection: TAG,
    });
    await sql`INSERT INTO zv_roles (name, description) VALUES (${ROLE}, 'Acceptance')`.execute(db);
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3) VALUES ('p', ${ROLE}, '*', ${POST}, 'read')`.execute(
      db,
    );
    await send('POST', '/api/admin/column-permissions', {
      collection_name: POST,
      column_name: 'title',
      role: ROLE,
      can_write: false,
    });
    await send('POST', '/api/admin/rls', {
      collection: POST,
      role: ROLE,
      filter_field: 'title',
      filter_value_source: 'static:x',
    });
    await sql`INSERT INTO zv_validation_rules (collection, field_name, rule_type, rule_config, error_message)
              VALUES (${POST}, 'title', 'length', '{"max": 80}'::jsonb, 'Too long')`.execute(db);
  });

  afterAll(async () => {
    await teardown();
    await raw.close();
  });

  it('pull, then apply on an instance without it, gives the same schema and the same files', async () => {
    const before = await snapshot();
    const files = await pull();
    expect(Object.keys(files).filter((p) => MINE.test(p))).toHaveLength(3);

    await teardown();
    expect(await snapshot()).not.toBe(before);

    const res = await app.request('/api/admin/schema/apply', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    expect(res.status).toBe(200);

    expect(await snapshot()).toBe(before);
    const again = await pull();
    for (const path of Object.keys(files)) expect(again[path]).toBe(files[path]);
    expect(Object.keys(again).sort()).toEqual(Object.keys(files).sort());
  });
});
