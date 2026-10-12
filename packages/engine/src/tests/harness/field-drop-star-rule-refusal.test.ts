/**
 * A `*` row rule that names a field blocks dropping it — with a refusal that
 * says so, before any DDL.
 *
 * A rule for collection `*` compiles into the row-rule policy of EVERY
 * collection table, so a table with a column of that name gets a policy that
 * depends on it, and Postgres refuses the DROP COLUMN. `dropFieldRules` rightly
 * leaves `*` rules alone: deleting one, or rebuilding this table's policy
 * without it, would lift a restriction everywhere or here. It used to surface
 * as a 400 carrying Postgres' "cannot drop column … other objects depend on
 * it", which names neither the rule nor what to do.
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
const COLLECTION = `hstar_drop_${ts}`;
const TARGET = `hstar_drop_t_${ts}`;
// Unique names: a `*` rule reaches every collection with a column so named.
const G = `g_${ts}`;
const OWNER = `owner_${ts}`;
const LOCAL = `local_${ts}`;
// A role nobody holds: the rule's term on other tables is then inert.
const ROLE = `nobody_${ts}`;
const text = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});

async function rule(db: Database, collection: string, field: string, value: string) {
  const r = await sql<{ id: string }>`
    INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source)
    VALUES (${collection}, ${ROLE}, ${field}, 'eq', ${value}) RETURNING id`.execute(db);
  return String(r.rows[0]?.id);
}

async function hasColumn(db: Database, table: string, column: string) {
  const r = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`.execute(
    db,
  );
  return r.rows[0]?.n === '1';
}

async function ruleExists(db: Database, id: string) {
  const r = await sql`SELECT 1 FROM zvd_rls_policies WHERE id = ${id}`.execute(db);
  return r.rows.length === 1;
}

d('a `*` row rule naming a field refuses its drop with 409', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let starG = '';
  let localG = '';
  let starOwner = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, { name: TARGET, fields: [text('label')] } as never);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        text(G),
        text(LOCAL),
        {
          name: OWNER,
          type: 'm2o',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: TARGET },
        },
      ],
    } as never);
    starG = await rule(db, '*', G, 'static:1');
    localG = await rule(db, COLLECTION, G, 'static:2');
    starOwner = await rule(db, '*', OWNER, `static:${crypto.randomUUID()}`);
    await rule(db, COLLECTION, LOCAL, 'static:3');
    await applyRowRulePolicy(db, COLLECTION);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE role = ${ROLE}`.execute(db);
    for (const c of [COLLECTION, TARGET]) {
      await db
        .deleteFrom('zvd_relations')
        .where((eb) => eb.or([eb('source_collection', '=', c), eb('target_collection', '=', c)]))
        .execute();
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${c}" CASCADE`).execute(db);
      await db.deleteFrom('zvd_collections').where('name', '=', c).execute();
    }
  });

  it('DELETE /api/collections/:name/fields/:field answers 409 naming the rule, and changes nothing', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/${G}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    const body = await res.text();
    expect(res.status, body).toBe(409);
    expect(JSON.parse(body).detail).toBe(
      `Field '${G}' is used by row rule ${starG} (collection '*'). Edit or remove the rule first.`,
    );
    expect(await hasColumn(db, `zvd_${COLLECTION}`, G)).toBe(true);
    expect(await ruleExists(db, starG)).toBe(true);
    // The collection's own rule is not deleted by a refused drop either.
    expect(await ruleExists(db, localG)).toBe(true);
  });

  it('DDLManager.removeField refuses the same way', async () => {
    const err = await DDLManager.removeField(db, COLLECTION, G).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409 });
    expect(await hasColumn(db, `zvd_${COLLECTION}`, G)).toBe(true);
  });

  it('DELETE /api/relations/:id answers 409 when its FK column is named by a `*` rule', async () => {
    const rel = await db
      .selectFrom('zvd_relations')
      .select('id')
      .where('source_collection', '=', COLLECTION)
      .where('source_field', '=', OWNER)
      .executeTakeFirstOrThrow();
    const res = await app.request(`/api/relations/${rel.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    const body = await res.text();
    expect(res.status, body).toBe(409);
    expect(JSON.parse(body).detail).toContain(`row rule ${starOwner}`);
    expect(await hasColumn(db, `zvd_${COLLECTION}`, OWNER)).toBe(true);
  });

  it("a rule for the field's own collection does not block: it goes with the field", async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/${LOCAL}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await hasColumn(db, `zvd_${COLLECTION}`, LOCAL)).toBe(false);
  });

  it('the drop succeeds once the `*` rule is gone', async () => {
    await sql`DELETE FROM zvd_rls_policies WHERE id = ${starG}`.execute(db);
    await applyRowRulePolicy(db, COLLECTION);
    const res = await app.request(`/api/collections/${COLLECTION}/fields/${G}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await hasColumn(db, `zvd_${COLLECTION}`, G)).toBe(false);
    expect(await ruleExists(db, localG)).toBe(false);
  });
});
