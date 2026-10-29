/**
 * A collection file's `indexes`: a unique key over several fields, per tenant
 * like a field's own `unique` — `UNIQUE (tenant_id, …fields)`.
 *
 * Created with the collection, even over fields its relations create; the data
 * API answers a repeat with 409; the export writes it back so the same files
 * plan nothing; removing or adding it is a step with an op; a key dropped out of
 * band is drift; rows that already repeat refuse the build and leave no index.
 * A required key column whose relation sets it NULL is refused at plan.
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
const PARENT = 'cu_projects';
const CHILD = 'cu_members';

const parentFile = { name: PARENT, fields: [{ name: 'title', type: 'text' }] };
const childFile = (extra: Record<string, unknown> = {}) => ({
  name: CHILD,
  fields: [
    { name: 'project_id', type: 'm2o', required: true, options: { related_collection: PARENT } },
    { name: 'member', type: 'text' },
  ],
  relations: [
    {
      name: `${CHILD}_project_id`,
      type: 'm2o',
      field: 'project_id',
      target: PARENT,
      onDelete: 'CASCADE',
    },
  ],
  indexes: [{ fields: ['project_id', 'member'], unique: true }],
  ...extra,
});

d('a collection file declares a unique key over several fields', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

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
  /** The instance's files with ours in place of its versions of them. */
  const withFiles = async (...cols: Record<string, unknown>[]) => ({
    ...(await pull()),
    ...Object.fromEntries(cols.map((c) => [`collections/${c.name}.json`, serialize(c)])),
  });
  const plan = async (files: Record<string, string>) => {
    const res = await call('POST', '/api/admin/schema/plan', { files });
    const body = (await res.json()) as {
      steps?: { change: string; target: string; action: string; op?: unknown }[];
      detail?: string;
    };
    return body.detail ?? body.steps?.map((s) => `${s.change} ${s.target} ${s.action} ${!!s.op}`);
  };
  const keys = async () =>
    (
      await sql<{ def: string }>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = ${`zvd_${CHILD}`}::regclass AND contype = 'u'`.execute(db)
    ).rows.map((r) => r.def);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_relations WHERE source_collection = ${CHILD}`.execute(db);
    await dropTestCollection(db, CHILD);
    await dropTestCollection(db, PARENT);
  });

  it('creates it, answers a repeat with 409, and round-trips through the export', async () => {
    const files = await withFiles(parentFile, childFile());
    expect(await plan(files)).toContain(`+ ${CHILD} add unique index (project_id, member) true`);
    const applied = await call('POST', '/api/admin/schema/apply', { files });
    expect(applied.status).toBe(200);
    expect(await keys()).toEqual(['UNIQUE (tenant_id, project_id, member)']);

    const p = (await (await call('POST', `/api/data/${PARENT}`, { title: 'p' })).json()) as {
      data?: { id: string };
      id?: string;
    };
    const project_id = p.data?.id ?? p.id;
    expect((await call('POST', `/api/data/${CHILD}`, { project_id, member: 'a' })).status).toBe(
      201,
    );
    expect((await call('POST', `/api/data/${CHILD}`, { project_id, member: 'b' })).status).toBe(
      201,
    );
    const repeat = await call('POST', `/api/data/${CHILD}`, { project_id, member: 'a' });
    expect(repeat.status).toBe(409);
    expect(((await repeat.json()) as { detail?: string }).detail).toBe('unique_violation');

    const exported = JSON.parse((await pull())[`collections/${CHILD}.json`]);
    expect(exported.indexes).toEqual([{ fields: ['project_id', 'member'], unique: true }]);
    expect(await plan(await withFiles(parentFile, childFile()))).toEqual([]);
  }, 60_000);

  it('removing and adding it are steps with ops; a key dropped by hand is drift', async () => {
    const without = await withFiles(parentFile, childFile({ indexes: undefined }));
    expect(await plan(without)).toEqual([
      `- ${CHILD} remove unique index (project_id, member) true`,
    ]);
    expect((await call('POST', '/api/admin/schema/apply', { files: without })).status).toBe(200);
    expect(await keys()).toEqual([]);

    const back = await withFiles(parentFile, childFile());
    expect(await plan(back)).toEqual([`+ ${CHILD} add unique index (project_id, member) true`]);
    expect((await call('POST', '/api/admin/schema/apply', { files: back })).status).toBe(200);
    expect(await keys()).toEqual(['UNIQUE (tenant_id, project_id, member)']);

    const [{ conname }] = (
      await sql<{ conname: string }>`
        SELECT conname FROM pg_constraint
         WHERE conrelid = ${`zvd_${CHILD}`}::regclass AND contype = 'u'`.execute(db)
    ).rows;
    await sql`ALTER TABLE ${sql.id(`zvd_${CHILD}`)} DROP CONSTRAINT ${sql.id(conname)}`.execute(db);
    expect(await plan(back)).toEqual([`+ ${CHILD} add unique index (project_id, member) true`]);
  }, 60_000);

  it('rows that already repeat refuse the build and leave no index behind', async () => {
    const p = (await (await call('POST', `/api/data/${PARENT}`, { title: 'q' })).json()) as {
      data?: { id: string };
      id?: string;
    };
    const project_id = p.data?.id ?? p.id;
    for (let i = 0; i < 2; i++) {
      expect((await call('POST', `/api/data/${CHILD}`, { project_id, member: 'x' })).status).toBe(
        201,
      );
    }
    const res = await call('POST', '/api/admin/schema/apply', {
      files: await withFiles(parentFile, childFile()),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain(
      'rows already repeat these values within a tenant',
    );
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_index WHERE indrelid = ${`zvd_${CHILD}`}::regclass
         AND indisunique AND indnatts = 3`.execute(db);
    expect(left.rows[0]?.n).toBe(0);
  }, 60_000);

  it('refuses a malformed index, and a required key whose relation sets it NULL', async () => {
    const bad = async (extra: Record<string, unknown>) =>
      plan(await withFiles(parentFile, childFile(extra)));
    expect(await bad({ indexes: [{ fields: ['member'], unique: true }] })).toContain(
      'an index names two or more distinct fields',
    );
    expect(await bad({ indexes: [{ fields: ['member', 'nope'], unique: true }] })).toContain(
      'an index names two or more distinct fields',
    );
    expect(await bad({ indexes: [{ fields: ['project_id', 'member'] }] })).toContain(
      'only unique indexes are supported',
    );

    const setNull = childFile();
    // Left out, onDelete is SET NULL: the same contradiction.
    delete (setNull.relations[0] as Record<string, unknown>).onDelete;
    expect(await plan(await withFiles(parentFile, setNull))).toBe(
      `collections/${CHILD}.json: relation "${CHILD}_project_id": ${CHILD}.project_id is required, ` +
        `so onDelete cannot be SET NULL (deleting a ${PARENT} row would fail); use CASCADE, RESTRICT or NO ACTION`,
    );
  }, 60_000);
});
