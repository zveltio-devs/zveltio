/**
 * Routers under `TXN_SKIP_PREFIXES` get no request transaction, so a handler
 * that writes twice keeps its first write when the second fails. Each case here
 * plants a trigger that refuses the SECOND write and asserts the first is gone.
 *
 * The triggers match only this file's marker names, and are dropped in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TS = Date.now();
const COLL = `atom_a_${TS}`;
const DROP = `atom_drop_${TS}`;
const FLOW = `atom_flow_${TS}`;

d('TXN_SKIP routers roll back a half-finished write', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const metaFields = async (name: string): Promise<string[]> => {
    DDLManager.invalidateCache(name);
    const row = await DDLManager.getCollection(db, name);
    const f = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    return (f as { name: string }[]).map((x) => x.name);
  };

  const hasColumn = async (table: string, column: string) => {
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`.execute(
      db,
    );
    return r.rows[0].n === 1;
  };

  const field = (name: string) => ({
    name,
    type: 'text',
    required: false,
    unique: false,
    indexed: false,
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    for (const name of [COLL, DROP]) {
      const res = await req('POST', '/api/collections', { name, fields: [field('title')] });
      expect(res.status).toBe(202);
    }
    // Present before the refusing triggers exist, so removing them can be refused.
    expect((await req('POST', `/api/collections/${COLL}/fields`, field('atom_del'))).status).toBe(
      200,
    );
    expect(
      (
        await req('POST', '/api/relations', {
          name: `${COLL}_atom_relok`,
          type: 'm2o',
          source_collection: COLL,
          source_field: 'atom_relok',
          target_collection: COLL,
        })
      ).status,
    ).toBe(201);

    await sql
      .raw(`
      CREATE OR REPLACE FUNCTION atom_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'zvd_collections' THEN
          IF TG_OP = 'DELETE' AND OLD.name = '${DROP}' THEN
            RAISE EXCEPTION 'atom: refused delete';
          END IF;
          IF TG_OP = 'UPDATE' AND NEW.fields::text LIKE '%atom_add%' THEN
            RAISE EXCEPTION 'atom: refused add';
          END IF;
          IF TG_OP = 'UPDATE' AND OLD.fields::text LIKE '%atom_del%'
             AND NEW.fields::text NOT LIKE '%atom_del%' THEN
            RAISE EXCEPTION 'atom: refused remove';
          END IF;
        ELSIF TG_TABLE_NAME = 'zvd_relations' THEN
          IF TG_OP = 'INSERT' AND NEW.source_field = 'atom_relboom' THEN
            RAISE EXCEPTION 'atom: refused relation';
          END IF;
          IF TG_OP = 'DELETE' AND OLD.source_field = 'atom_relok' THEN
            RAISE EXCEPTION 'atom: refused relation delete';
          END IF;
        ELSIF TG_TABLE_NAME = 'zv_flow_steps' AND NEW.name = 'atom_boom' THEN
          RAISE EXCEPTION 'atom: refused step';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$;
      CREATE TRIGGER atom_refuse BEFORE INSERT OR UPDATE OR DELETE ON zvd_collections
        FOR EACH ROW EXECUTE FUNCTION atom_refuse();
      CREATE TRIGGER atom_refuse BEFORE INSERT OR DELETE ON zvd_relations
        FOR EACH ROW EXECUTE FUNCTION atom_refuse();
      CREATE TRIGGER atom_refuse BEFORE INSERT ON zv_flow_steps
        FOR EACH ROW EXECUTE FUNCTION atom_refuse();
    `)
      .execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    for (const t of ['zvd_collections', 'zvd_relations', 'zv_flow_steps']) {
      await sql.raw(`DROP TRIGGER IF EXISTS atom_refuse ON ${t}`).execute(db);
    }
    await sql.raw('DROP FUNCTION IF EXISTS atom_refuse()').execute(db);
    await sql`DELETE FROM zv_flows WHERE name LIKE ${`${FLOW}%`}`.execute(db);
    for (const name of [COLL, DROP]) {
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`).execute(db);
      await sql`DELETE FROM zvd_relations WHERE source_collection = ${name}`.execute(db);
      await db.deleteFrom('zvd_collections').where('name', '=', name).execute();
      DDLManager.invalidateCache(name);
    }
  });

  it('DELETE /api/collections/:name keeps the table when the metadata delete fails', async () => {
    const res = await req('DELETE', `/api/collections/${DROP}?force=true`);
    expect(res.status).toBe(400);
    // Before: the table was dropped and the metadata row stayed — a collection
    // listed everywhere that every retry refused as "not found".
    expect(await DDLManager.tableExists(db, DROP)).toBe(true);
    expect(await metaFields(DROP)).toContain('title');
  });

  it('POST /api/collections/:name/fields adds no column when the metadata write fails', async () => {
    const res = await req('POST', `/api/collections/${COLL}/fields`, field('atom_add'));
    expect(res.status).toBe(400);
    expect(await metaFields(COLL)).not.toContain('atom_add');
    expect(await hasColumn(`zvd_${COLL}`, 'atom_add')).toBe(false);
  });

  it('DELETE /api/collections/:name/fields/:field keeps the column when the metadata write fails', async () => {
    const res = await req('DELETE', `/api/collections/${COLL}/fields/atom_del`);
    expect(res.status).toBe(400);
    expect(await metaFields(COLL)).toContain('atom_del');
    expect(await hasColumn(`zvd_${COLL}`, 'atom_del')).toBe(true);
  });

  it('POST /api/relations leaves no metadata field when the relation row is refused', async () => {
    const res = await req('POST', '/api/relations', {
      name: `${COLL}_atom_relboom`,
      type: 'm2o',
      source_collection: COLL,
      source_field: 'atom_relboom',
      target_collection: COLL,
    });
    expect(res.status).toBe(400);
    expect(await metaFields(COLL)).not.toContain('atom_relboom');
  });

  it('DELETE /api/relations/:id keeps column and metadata when the relation row delete fails', async () => {
    const rel = await db
      .selectFrom('zvd_relations')
      .select('id')
      .where('source_collection', '=', COLL)
      .where('source_field', '=', 'atom_relok')
      .executeTakeFirstOrThrow();
    const res = await req('DELETE', `/api/relations/${rel.id}`);
    expect(res.status).toBe(400);
    expect(await metaFields(COLL)).toContain('atom_relok');
    expect(await hasColumn(`zvd_${COLL}`, 'atom_relok')).toBe(true);
  });

  const step = (name: string) => ({
    type: 'webhook',
    name,
    config: { url: 'https://example.com/hook', method: 'POST' },
  });

  it('POST /api/flows leaves no flow behind when its steps are refused', async () => {
    const res = await req('POST', '/api/flows', {
      name: FLOW,
      trigger: { type: 'manual' },
      steps: [step('atom_boom')],
      is_active: true,
    });
    expect(res.status).toBe(500);
    // Before: an active flow with zero steps, and every retry added another.
    const rows = await sql`SELECT id FROM zv_flows WHERE name = ${FLOW}`.execute(db);
    expect(rows.rows.length).toBe(0);
  });

  it('PATCH /api/flows/:id keeps the old flow when its new steps are refused', async () => {
    const created = await req('POST', '/api/flows', {
      name: `${FLOW}_p`,
      trigger: { type: 'manual' },
      steps: [step('first')],
      is_active: true,
    });
    expect(created.status).toBe(201);
    const { flow } = (await created.json()) as { flow: { id: string } };

    const res = await req('PATCH', `/api/flows/${flow.id}`, {
      name: `${FLOW}_renamed`,
      steps: [step('atom_boom')],
    });
    expect(res.status).toBe(500);
    const row = await sql<{
      name: string;
    }>`SELECT name FROM zv_flows WHERE id = ${flow.id}`.execute(db);
    expect(row.rows[0].name).toBe(`${FLOW}_p`);
    const steps = await sql<{ name: string }>`
      SELECT name FROM zv_flow_steps WHERE flow_id = ${flow.id}`.execute(db);
    expect(steps.rows.map((s) => s.name)).toEqual(['first']);
  });
});
