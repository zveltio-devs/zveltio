/**
 * A relation's `on_delete`/`on_update` is its foreign key's, not a label beside
 * it: `PATCH /api/relations/:id` and a schema apply re-create the key, the export
 * reads what the database enforces, and a required key with SET NULL is refused
 * by every route that could make one, as the plan refuses it in a file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { serialize } from '../../lib/schema-artifact/export.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = 'fks_projects';
const CHILD = 'fks_tasks';
const REL = `${CHILD}_project_id`;

type Field = Record<string, unknown>;

const parentFile = { name: PARENT, fields: [{ name: 'title', type: 'text' }] };
const childFile = (onDelete: string): { name: string; fields: Field[]; relations: Field[] } => ({
  name: CHILD,
  fields: [
    { name: 'project_id', type: 'm2o', required: true, options: { related_collection: PARENT } },
    { name: 'lead_id', type: 'm2o', options: { related_collection: PARENT } },
    { name: 'title', type: 'text' },
  ],
  relations: [
    { name: REL, type: 'm2o', field: 'project_id', target: PARENT, onDelete },
    // onDelete left out: SET NULL, which a nullable key may have.
    { name: `${CHILD}_lead_id`, type: 'm2o', field: 'lead_id', target: PARENT },
  ],
});

d('a relation change reaches its foreign key', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let relId: string;

  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const pull = async () =>
    (
      (await (await call('GET', '/api/admin/schema/export')).json()) as {
        files: Record<string, string>;
      }
    ).files;
  const withFiles = async (...cols: Record<string, unknown>[]) => ({
    ...(await pull()),
    ...Object.fromEntries(cols.map((c) => [`collections/${c.name}.json`, serialize(c)])),
  });
  const plan = async (files: Record<string, string>) => {
    const body = (await (await call('POST', '/api/admin/schema/plan', { files })).json()) as {
      steps?: { change: string; target: string; action: string }[];
      detail?: string;
    };
    return body.detail ?? body.steps?.map((s) => `${s.change} ${s.target} ${s.action}`);
  };
  // 4xx bodies are problem details: the route's message is `detail`.
  const reason = async (res: Response) => ((await res.json()) as { detail?: string }).detail;
  /** The key on `column`, as the database enforces it. */
  const fk = async (column: string) =>
    (
      await sql<{ def: string }>`
        SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.conrelid = ${`zvd_${CHILD}`}::regclass AND c.contype = 'f' AND a.attname = ${column}`.execute(
        db,
      )
    ).rows.map((r) => r.def);
  const row = async () =>
    (
      await sql<{ on_delete: string; on_update: string }>`
        SELECT on_delete, on_update FROM zvd_relations WHERE id = ${relId}`.execute(db)
    ).rows[0];
  const insert = async (collection: string, body: Record<string, unknown>) => {
    const res = await call('POST', `/api/data/${collection}`, body);
    expect(res.status).toBe(201);
    const j = (await res.json()) as { data?: { id: string }; id?: string };
    return (j.data?.id ?? j.id) as string;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const applied = await call('POST', '/api/admin/schema/apply', {
      files: await withFiles(parentFile, childFile('CASCADE')),
    });
    expect(applied.status).toBe(200);
    relId = (
      await sql<{ id: string }>`SELECT id FROM zvd_relations WHERE name = ${REL}`.execute(db)
    ).rows[0].id;
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_relations WHERE source_collection IN (${CHILD}, ${PARENT})`.execute(
      db,
    );
    await dropTestCollection(db, CHILD);
    await dropTestCollection(db, PARENT);
  });

  it('refuses every route that would make a required key SET NULL, and changes nothing', async () => {
    const before = await fk('project_id');
    const patch = await call('PATCH', `/api/relations/${relId}`, { on_delete: 'SET NULL' });
    expect(patch.status).toBe(422);
    expect(await reason(patch)).toBe(
      `relation "${REL}": ${CHILD}.project_id is required, so onDelete cannot be SET NULL ` +
        `(deleting a ${PARENT} row would fail); use CASCADE, RESTRICT or NO ACTION`,
    );
    expect((await row()).on_delete).toBe('CASCADE');
    expect(await fk('project_id')).toEqual(before);

    // An o2m onto the required key, its actions left at SET NULL.
    const post = await call('POST', '/api/relations', {
      name: `${PARENT}_tasks`,
      type: 'o2m',
      source_collection: PARENT,
      source_field: 'tasks',
      target_collection: CHILD,
      target_field: 'project_id',
    });
    expect(post.status).toBe(422);
    expect(await reason(post)).toContain(
      `${CHILD}.project_id is required, so onDelete cannot be SET NULL`,
    );
    const o2m = await sql`SELECT 1 FROM zvd_relations WHERE name = ${`${PARENT}_tasks`}`.execute(
      db,
    );
    expect(o2m.rows).toHaveLength(0);

    // Making the SET NULL key required.
    const req = await call('PATCH', `/api/collections/${CHILD}/fields/lead_id`, { required: true });
    expect(req.status).toBe(422);
    expect(await reason(req)).toContain(
      `${CHILD}.lead_id is required, so onDelete cannot be SET NULL`,
    );
    const nn = await sql<{ n: boolean }>`
      SELECT attnotnull AS n FROM pg_attribute
       WHERE attrelid = ${`zvd_${CHILD}`}::regclass AND attname = 'lead_id'`.execute(db);
    expect(nn.rows[0].n).toBe(false);
  }, 60_000);

  it('PATCH re-creates the foreign key: RESTRICT then refuses deleting a parent with children', async () => {
    const res = await call('PATCH', `/api/relations/${relId}`, { on_delete: 'RESTRICT' });
    expect(res.status).toBe(200);
    expect(await fk('project_id')).toEqual([
      `FOREIGN KEY (project_id) REFERENCES zvd_${PARENT}(id) ON UPDATE CASCADE ON DELETE RESTRICT`,
    ]);
    const parent = await insert(PARENT, { title: 'p' });
    await insert(CHILD, { project_id: parent, title: 't' });
    const del = await call('DELETE', `/api/data/${PARENT}/${parent}`);
    expect(del.status).toBeGreaterThanOrEqual(400);
    const left = await sql`SELECT 1 FROM ${sql.id(`zvd_${PARENT}`)} WHERE id = ${parent}`.execute(
      db,
    );
    expect(left.rows).toHaveLength(1);

    // The export reads the key, so the file now says RESTRICT and plans nothing.
    const exported = JSON.parse((await pull())[`collections/${CHILD}.json`]) as {
      relations: { name: string; onDelete: string }[];
    };
    expect(exported.relations.find((r) => r.name === REL)?.onDelete).toBe('RESTRICT');
    expect(await plan(await withFiles(parentFile, childFile('RESTRICT')))).toEqual([]);
  }, 60_000);

  it('a file changing onDelete re-creates the key, and the plan after it is empty', async () => {
    const files = await withFiles(parentFile, childFile('CASCADE'));
    expect(await plan(files)).toEqual([`~ ${CHILD} alter relation ${REL}`]);
    expect((await call('POST', '/api/admin/schema/apply', { files })).status).toBe(200);
    expect(await fk('project_id')).toEqual([
      `FOREIGN KEY (project_id) REFERENCES zvd_${PARENT}(id) ON UPDATE CASCADE ON DELETE CASCADE`,
    ]);
    expect((await row()).on_delete).toBe('CASCADE');
    expect(await plan(await withFiles(parentFile, childFile('CASCADE')))).toEqual([]);
  }, 60_000);

  it('a key changed out of band is drift the plan shows, and the file repairs it', async () => {
    const [{ name }] = (
      await sql<{ name: string }>`
        SELECT c.conname AS name FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.conrelid = ${`zvd_${CHILD}`}::regclass AND c.contype = 'f' AND a.attname = 'project_id'`.execute(
        db,
      )
    ).rows;
    await sql
      .raw(
        `ALTER TABLE zvd_${CHILD} DROP CONSTRAINT "${name}", ADD CONSTRAINT "${name}" ` +
          `FOREIGN KEY (project_id) REFERENCES zvd_${PARENT}(id) ON DELETE NO ACTION ON UPDATE CASCADE`,
      )
      .execute(db);
    const files = await withFiles(parentFile, childFile('CASCADE'));
    expect(await plan(files)).toEqual([`~ ${CHILD} alter relation ${REL}`]);
    expect((await call('POST', '/api/admin/schema/apply', { files })).status).toBe(200);
    expect((await fk('project_id'))[0]).toContain('ON DELETE CASCADE');
    expect(await plan(await withFiles(parentFile, childFile('CASCADE')))).toEqual([]);
  }, 60_000);

  it('a file turning a SET NULL key required with CASCADE applies, and back', async () => {
    await sql`DELETE FROM ${sql.id(`zvd_${CHILD}`)}`.execute(db);
    const strict = childFile('CASCADE');
    strict.fields[1] = { ...strict.fields[1], required: true };
    strict.relations[1] = { ...strict.relations[1], onDelete: 'CASCADE' };
    for (const file of [strict, childFile('CASCADE')]) {
      const files = await withFiles(parentFile, file);
      const res = await call('POST', '/api/admin/schema/apply', { files });
      expect(res.status).toBe(200);
      expect(await plan(await withFiles(parentFile, file))).toEqual([]);
    }
    expect((await fk('lead_id'))[0]).toContain('ON DELETE SET NULL');
  }, 60_000);
});
