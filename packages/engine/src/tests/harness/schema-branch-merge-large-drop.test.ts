/**
 * A schema-branch merge drops a field of a table over 100k rows the way it
 * drops one of a small table: through `DDLManager.removeField`, so the field's
 * rules go first and a `*` row rule naming it refuses with the 409 of #1059.
 *
 * Over 100k rows the merge used to run a Ghost DDL `drop_column` before
 * `removeField`, i.e. before `dropFieldRules`: the swap re-created the row-rule
 * policy on a table without the column and failed with "column … does not
 * exist" — for a `*` rule and for the collection's own rule alike, after
 * copying the whole table. DROP COLUMN rewrites nothing in Postgres, so the
 * copy bought no availability either.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { applyRowRulePolicy } from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ts = Date.now();
const COL = `sbm_large_${ts}`;
const TABLE = `zvd_${COL}`;
// Over the merge's 100k-row threshold.
const ROWS = 100_001;
// Unique names: a `*` rule reaches every collection with a column so named.
const STAR = `g_${ts}`;
const LOCAL = `local_${ts}`;
const ROLE = `nobody_${ts}`;
const text = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});

d('schema-branch merge drops a field of a >100k-row table after its rules', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let starRule = '';
  let localRule = '';
  const branches: string[] = [];
  const schemas: string[] = [];

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function mergeRemoveField(field: string) {
    const res = await post('/api/schema/branches', { name: `sbm-large-${field}` });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { branch: { id: string }; schema: string };
    branches.push(created.branch.id);
    schemas.push(created.schema);
    const change = await post(`/api/schema/branches/${created.branch.id}/changes`, {
      type: 'remove_field',
      payload: { collection: COL, field },
    });
    expect(change.status).toBe(200);
    return (await (await post(`/api/schema/branches/${created.branch.id}/merge`)).json()) as {
      applied: string[];
      errors: string[];
    };
  }

  async function rule(collection: string, field: string, value: string) {
    const r = await sql<{ id: string }>`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source)
      VALUES (${collection}, ${ROLE}, ${field}, 'eq', ${value}) RETURNING id`.execute(db);
    return String(r.rows[0]?.id);
  }

  const hasColumn = async (column: string) =>
    (
      await sql`SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = ${TABLE}
                   AND column_name = ${column}`.execute(db)
    ).rows.length === 1;

  const ruleExists = async (id: string) =>
    (await sql`SELECT 1 FROM zvd_rls_policies WHERE id = ${id}`.execute(db)).rows.length === 1;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COL,
      fields: [text(STAR), text(LOCAL)],
    } as never);
    await sql`INSERT INTO ${sql.id(TABLE)} (${sql.id(LOCAL)})
              SELECT 'r' || g FROM generate_series(1, ${ROWS}) g`.execute(db);
    starRule = await rule('*', STAR, 'static:1');
    localRule = await rule(COL, LOCAL, 'static:2');
    await applyRowRulePolicy(db, COL);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    for (const id of branches) {
      await sql`DELETE FROM zv_schema_branches WHERE id = ${id}`.execute(db);
    }
    for (const s of schemas) await sql`DROP SCHEMA IF EXISTS ${sql.id(s)} CASCADE`.execute(db);
    await sql`DELETE FROM zvd_rls_policies WHERE role = ${ROLE}`.execute(db);
    await sql`DROP TABLE IF EXISTS ${sql.id(TABLE)} CASCADE`.execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COL).execute();
  });

  it('a `*` rule naming the field refuses the drop with its 409 message; column and rule stay', async () => {
    const out = await mergeRemoveField(STAR);
    expect(out.applied).toEqual([]);
    expect(out.errors).toEqual([
      `remove_field: Field '${STAR}' is used by row rule ${starRule} (collection '*'). ` +
        'Edit or remove the rule first.',
    ]);
    expect(await hasColumn(STAR)).toBe(true);
    expect(await ruleExists(starRule)).toBe(true);
    // The failed merge leaves the branch open with the failed change, so it
    // can be retried once the rule is edited.
    const branch = await sql<{ status: string; changes: unknown }>`
      SELECT status, changes FROM zv_schema_branches WHERE id = ${branches.at(-1)}`.execute(db);
    expect(branch.rows[0]?.status).toBe('open');
    const changes = branch.rows[0]?.changes;
    const list = (typeof changes === 'string' ? JSON.parse(changes) : changes) as unknown[];
    expect(list).toHaveLength(1);
  }, 120_000);

  it("the collection's own rule goes with the field, and the column is dropped", async () => {
    const out = await mergeRemoveField(LOCAL);
    expect(out.errors).toEqual([]);
    expect(out.applied).toEqual([`Remove field: ${LOCAL} from ${COL}`]);
    expect(await hasColumn(LOCAL)).toBe(false);
    expect(await ruleExists(localRule)).toBe(false);
    const meta = await sql<{ fields: unknown }>`
      SELECT fields FROM zvd_collections WHERE name = ${COL}`.execute(db);
    const raw = meta.rows[0]?.fields;
    const fields = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ name: string }>;
    expect(fields.map((f) => f.name)).not.toContain(LOCAL);
  }, 120_000);
});
