/**
 * A unique field merged into a table past 100 000 rows gets its per-tenant key
 * on the ghost, before the swap.
 *
 * GhostDDL took only `ADD COLUMN` text, so the merge added the column through
 * the ghost and then ran `ALTER TABLE … ADD UNIQUE (tenant_id, <field>)` on the
 * swapped-in table: an index build over the whole table under its lock, after
 * the migration whose point is not to hold one. The `add_column` operation now
 * builds the key on the ghost. The copy and the changelog replay never write the
 * new column — the original has none — so it holds only its default while the
 * writes made during the run land.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  cancelPendingCleanups,
  DDLManager,
  GhostDDL,
  sweepGhostOrphans,
} from '../../lib/data/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const STEPS = `hgu_${SFX}`;
const ROUTE = `hgu_route_${SFX}`;
const OTHER_TENANT = crypto.randomUUID();
const ROWS = 100_001;
const code = { name: 'code', type: 'text', required: false, unique: true, indexed: false };

/** `[name, definition]` of every unique key on `table`. */
async function uniqueKeys(db: Database, table: string): Promise<[string, string][]> {
  const r = await sql<{ name: string; def: string }>`
    SELECT conname::text AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = to_regclass(${table}) AND contype = 'u' ORDER BY 1
  `.execute(db);
  return r.rows.map((x) => [x.name, x.def]);
}

d('ghost DDL builds a unique field’s key on the ghost', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  /** Inserts `value` as `tenant`; returns the SQLSTATE or 'ok'. */
  const put = async (table: string, value: string, tenant: string): Promise<string> => {
    try {
      await sql`
        INSERT INTO ${sql.id(table)} (title, code, tenant_id) VALUES ('k', ${value}, ${tenant}::uuid)
      `.execute(db);
      return 'ok';
    } catch (err) {
      return String((err as { errno?: string }).errno ?? err);
    }
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    for (const name of [STEPS, ROUTE]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      } as never);
    }
  });

  afterAll(async () => {
    if (!db) return;
    cancelPendingCleanups();
    for (const name of [STEPS, ROUTE]) {
      const table = `zvd_${name}`;
      for (const t of [`_zv_ghost_${table}`, `_zv_changelog_${table}`, table]) {
        await sql`DROP TABLE IF EXISTS ${sql.id(t)} CASCADE`.execute(db).catch(() => {});
      }
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', name)
        .execute()
        .catch(() => {});
    }
    await sweepGhostOrphans(db);
  });

  it('the key is on the ghost before the swap, and on the table after it', async () => {
    const table = `zvd_${STEPS}`;
    await sql`INSERT INTO ${sql.id(table)} (title) VALUES ('a'), ('b')`.execute(db);

    const migration = await GhostDDL.createGhost(db, table, [{ kind: 'add_column', field: code }]);
    const key: [string, string] = [`${table}_tenant_id_code_key`, 'UNIQUE (tenant_id, code)'];
    expect(await uniqueKeys(db, migration.ghostTable)).toEqual([key]);
    expect(await uniqueKeys(db, table)).toEqual([]);

    await GhostDDL.batchCopy(db, migration);
    await GhostDDL.applyChangelog(db, migration);
    await GhostDDL.atomicSwap(db, migration);
    expect(await uniqueKeys(db, table)).toEqual([key]);
  });

  it(`a merge past ${ROWS} rows keeps every concurrent write and keys per tenant`, async () => {
    const table = `zvd_${ROUTE}`;
    await sql`
      INSERT INTO ${sql.id(table)} (title) SELECT 's' || g FROM generate_series(1, ${ROWS}) g
    `.execute(db);

    const created = await app.request('/api/schema/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `hgu-${SFX}` }),
    });
    const { branch, schema } = (await created.json()) as { branch: { id: string }; schema: string };
    await app.request(`/api/schema/branches/${branch.id}/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ type: 'add_field', payload: { collection: ROUTE, field: code } }),
    });

    // Two tenants write for the whole merge: the copy, the replays and the swap.
    let done = false;
    const written: string[] = [];
    const writer = (async () => {
      for (let i = 0; !done; i++) {
        const title = `live-${i}`;
        const tenant = i % 2 === 0 ? DEFAULT_TENANT_ID : OTHER_TENANT;
        await sql`
          INSERT INTO ${sql.id(table)} (title, tenant_id) VALUES (${title}, ${tenant}::uuid)
        `.execute(db);
        written.push(title);
      }
    })();
    const res = await app.request(`/api/schema/branches/${branch.id}/merge`, {
      method: 'POST',
      headers: { cookie },
    });
    done = true;
    await writer;
    const body = (await res.json()) as { errors: string[] };
    await db.deleteFrom('zv_schema_branches').where('id', '=', branch.id).execute();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);

    expect(body.errors).toEqual([]);
    expect(await uniqueKeys(db, table)).toEqual([
      [`${table}_tenant_id_code_key`, 'UNIQUE (tenant_id, code)'],
    ]);

    // The writer has to have overlapped the merge, or this proves nothing.
    expect(written.length).toBeGreaterThan(1);
    const live = await sql<{ title: string }>`
      SELECT title FROM ${sql.id(table)} WHERE title LIKE 'live-%'
    `.execute(db);
    const kept = new Set(live.rows.map((r) => r.title));
    expect(written.filter((t) => !kept.has(t))).toEqual([]);
    const total = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.id(table)}`.execute(
      db,
    );
    expect(total.rows[0]!.n).toBe(ROWS + written.length);

    expect(await put(table, 'X-1', DEFAULT_TENANT_ID)).toBe('ok');
    expect(await put(table, 'X-1', OTHER_TENANT)).toBe('ok');
    expect(await put(table, 'X-1', DEFAULT_TENANT_ID)).toBe('23505');
  }, 180_000);
});
