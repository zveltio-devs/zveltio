/**
 * Phase C — PATCH field type change via collections route (field-type-conversions + DDL).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  asDefaultTenant,
  createGodSession,
  getTestApp,
  harnessAvailable,
  jobOutcome,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hptype_${Date.now()}`;

d('collections field type change (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'contact', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
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

  it('PATCH /:name/fields/:field changes text → email in metadata and DDL', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/contact`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ new_type: 'email' }),
    });
    // DR-36: a retype can rewrite the table, so it is a job to poll, whose
    // result is the body the route answered when it ran in the request.
    expect(res.status).toBe(202);
    const { job_id } = (await res.json()) as { job_id: string };
    const job = await app.request(`/api/collections/jobs/${job_id}`, { headers: { cookie } });
    expect(((await job.json()) as { job: unknown }).job).toMatchObject({
      type: 'alter_field',
      status: 'completed',
      error: null,
      result: {
        success: true,
        field: { name: 'contact', type: 'email' },
        actions: ['type text→email'],
      },
    });

    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    const contact = fields.find((f: { name: string }) => f.name === 'contact');
    expect(contact?.type).toBe('email');

    const cols = await asDefaultTenant(
      db,
      sql<{ udt_name: string }>`
      SELECT udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${`zvd_${COLLECTION}`}
        AND column_name = 'contact'
    `,
    );
    expect(cols.rows[0]?.udt_name).toBe('text');
  });

  // The type-change branch used to validate inside a `db.transaction().execute(async (trx) => {...})`
  // callback and `return c.json(...)` on failure — a return captured by the
  // transaction's own promise and discarded, not by the outer route handler,
  // so an invalid request fell through to the unconditional 200 success
  // response below it with the field silently left unchanged.
  it('PATCH with an unknown new_type answers 400, not a silent 200', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/contact`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ new_type: 'not_a_real_type' }),
    });
    expect(res.status).toBe(400);

    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    expect(fields.find((f: { name: string }) => f.name === 'contact')?.type).toBe('email');
  });

  it('PATCH converting to a relation type answers 400, not a silent 200', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/contact`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ new_type: 'm2o' }),
    });
    expect(res.status).toBe(400);

    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    expect(fields.find((f: { name: string }) => f.name === 'contact')?.type).toBe('email');
  });

  it('a retype the rows refuse fails its job with the reason and changes nothing', async () => {
    await asDefaultTenant(
      db,
      sql`INSERT INTO ${sql.id(`zvd_${COLLECTION}`)} (contact) VALUES ('not a number')`,
    );
    const res = await app.request(`/api/collections/${COLLECTION}/fields/contact`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ new_type: 'integer' }),
    });
    expect(await jobOutcome(app, res, { cookie })).toContain('failed: ');
    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    expect(fields.find((f: { name: string }) => f.name === 'contact')?.type).toBe('email');
  });

  it('a change that is no retype still answers 200 with its result', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/contact`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ indexed: true }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { actions: string[] }).actions).toEqual(['indexed→true']);
  });
});
