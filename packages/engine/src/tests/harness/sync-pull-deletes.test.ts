/**
 * Sync pull tells a client which rows were deleted.
 *
 * Pull read rows `updated_at` after the client's position, and a deleted row
 * has nothing left to read: an offline client kept every row deleted on the
 * server, forever. Each delete now leaves a tombstone (`zv_sync_tombstones`,
 * written by a trigger `DDLManager` puts on every collection table), returned
 * as `operation: 'delete'` on the same `(time, id)` keyset as the rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { runGarbageCollector } from '../../lib/runtime/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `hsyncdel_${Date.now()}`;
const TABLE = `zvd_${NAME}`;
const OTHER_TENANT = '4d000000-0000-0000-0000-0000000000d1';

type Change = { collection: string; id: string; operation: string; data?: { title?: string } };
type PullBody = {
  changes: Change[];
  serverTimestamp: number;
  hasMore?: boolean;
  cursors?: Record<string, string>;
  resync?: Record<string, boolean>;
};

d('sync pull returns deletes', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const pullAs = async (who: string, body: Record<string, unknown>): Promise<PullBody> => {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: who },
      body: JSON.stringify({ collections: [TABLE], since: 0, ...body }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as PullBody;
  };
  const pull = (body: Record<string, unknown>) => pullAs(cookie, body);
  const insert = async (on: Database, title: string): Promise<string> => {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO ${sql.table(TABLE)} (title) VALUES (${title}) RETURNING id::text AS id
    `.execute(on);
    return rows[0]!.id;
  };
  const deletesIn = (b: PullBody) =>
    b.changes.filter((ch) => ch.operation === 'delete').map((ch) => ch.id);
  // Every pull after this one starts from a cursor past everything that exists now.
  const caughtUp = async (): Promise<Record<string, string>> => {
    let cursors: Record<string, string> = {};
    for (let round = 0; round < 10; round++) {
      const body = await pull({ cursors });
      cursors = { ...cursors, ...body.cursors };
      if (!body.hasMore) return cursors;
    }
    throw new Error('never caught up');
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: NAME,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`
      INSERT INTO zv_tenants (id, slug, name) VALUES (${OTHER_TENANT}::uuid, 'hsyncdel-b', 'B')
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
  });

  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', NAME).execute();
    await sql`DELETE FROM zv_sync_tombstones WHERE collection = ${TABLE}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER_TENANT}::uuid`.execute(db);
  });

  it('a row deleted through the API reaches a client as a delete', async () => {
    const id = await insert(db, 'doomed');
    const cursors = await caughtUp();
    const res = await app.request(`/api/data/${NAME}/${id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBeLessThan(300);

    const body = await pull({ cursors });
    expect(body.changes).toEqual([expect.objectContaining({ id, operation: 'delete' })]);
    // And by `since`, for a client that keeps no cursor.
    const bySince = await pull({ since: Date.now() - 60_000 });
    expect(deletesIn(bySince)).toContain(id);
  });

  it('pages through deletes and inserts sharing one timestamp, each exactly once', async () => {
    const DEL = 600;
    const INS = 900;
    await sql
      .raw(`INSERT INTO "${TABLE}" (title) SELECT 'old' || g FROM generate_series(1, ${DEL}) g`)
      .execute(db);
    const cursors0 = await caughtUp();
    // One transaction: every tombstone and every new row carries the same now(),
    // so only the id orders them and the page boundary falls inside the tie.
    await db.transaction().execute(async (trx) => {
      await sql.raw(`DELETE FROM "${TABLE}" WHERE title LIKE 'old%'`).execute(trx);
      await sql
        .raw(`INSERT INTO "${TABLE}" (title) SELECT 'new' || g FROM generate_series(1, ${INS}) g`)
        .execute(trx);
    });

    const seen: Change[] = [];
    let cursors = cursors0;
    let pages = 0;
    for (; pages < 10; pages++) {
      const body = await pull({ cursors });
      seen.push(...body.changes);
      cursors = { ...cursors, ...body.cursors };
      if (!body.hasMore) break;
    }
    expect(pages).toBeGreaterThan(0);
    const dels = seen.filter((ch) => ch.operation === 'delete');
    const ups = seen.filter((ch) => ch.operation === 'upsert');
    expect(dels.length).toBe(DEL);
    expect(new Set(dels.map((ch) => ch.id)).size).toBe(DEL);
    expect(ups.length).toBe(INS);
    expect(new Set(ups.map((ch) => ch.id)).size).toBe(INS);
  });

  it('a delete committed after the pull still arrives, by cursor and by since', async () => {
    const x = await insert(db, 'x');
    const y = await insert(db, 'y');
    const cursors = await caughtUp();

    let first: PullBody | null = null;
    await db.transaction().execute(async (trx) => {
      // The tombstone carries this transaction's start.
      await sql`DELETE FROM ${sql.table(TABLE)} WHERE id = ${x}::uuid`.execute(trx);
      await Bun.sleep(5);
      // Committed, and newer: a position past it would skip x's tombstone.
      await sql`DELETE FROM ${sql.table(TABLE)} WHERE id = ${y}::uuid`.execute(db);
      first = await pull({ cursors });
    });
    const f = first as unknown as PullBody;
    expect(deletesIn(f)).not.toContain(x);
    expect(deletesIn(f)).not.toContain(y);

    const byCursor = await pull({ cursors: { ...cursors, ...f.cursors } });
    expect(deletesIn(byCursor)).toContain(x);
    expect(deletesIn(byCursor)).toContain(y);
    const bySince = await pull({ since: f.serverTimestamp });
    expect(deletesIn(bySince)).toContain(x);
  });

  it("another tenant's delete is not visible", async () => {
    const member = await createMemberSession(app, db, {
      grants: [
        { collection: NAME, actions: ['read'] },
        { collection: `data:${NAME}`, actions: ['read'] },
      ],
    });
    const mine = await insert(db, 'mine');
    const { rows } = await sql<{ id: string }>`
      INSERT INTO ${sql.table(TABLE)} (title, tenant_id) VALUES ('theirs', ${OTHER_TENANT}::uuid)
      RETURNING id::text AS id
    `.execute(db);
    const theirs = rows[0]!.id;
    const cursors = await caughtUp();
    await sql`DELETE FROM ${sql.table(TABLE)} WHERE id IN (${mine}::uuid, ${theirs}::uuid)`.execute(
      db,
    );

    const { rows: stones } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_sync_tombstones WHERE row_id = ${theirs}::uuid
    `.execute(db);
    expect(stones[0]!.n).toBe(1);
    const body = await pullAs(member.cookie, { cursors });
    expect(deletesIn(body)).toContain(mine);
    expect(deletesIn(body)).not.toContain(theirs);
  });

  // A parent unit (or god) may delete a child's row: the row's policy lets it
  // DELETE what it can see, while a tombstone written as the deleter's own unit
  // would fail the WITH CHECK every tenant table has. The harness owner is a
  // superuser and bypasses RLS, so the trigger runs as a plain role here.
  it('a delete across units still writes its tombstone under RLS', async () => {
    const theirs = (
      await sql<{ id: string }>`
        INSERT INTO ${sql.table(TABLE)} (title, tenant_id) VALUES ('child', ${OTHER_TENANT}::uuid)
        RETURNING id::text AS id
      `.execute(db)
    ).rows[0]!.id;
    const seen = await db
      .transaction()
      .execute(async (trx) => {
        await sql`ALTER FUNCTION zveltio_sync_tombstone() OWNER TO zveltio_rls`.execute(trx);
        await sql`
          SELECT set_config('role', 'zveltio_rls', true),
                 set_config('zveltio.current_tenant', '00000000-0000-0000-0000-000000000001', true),
                 set_config('zveltio.visible_tenants',
                   ${`00000000-0000-0000-0000-000000000001,${OTHER_TENANT}`}, true)
        `.execute(trx);
        const del = await sql`
          DELETE FROM ${sql.table(TABLE)} WHERE id = ${theirs}::uuid RETURNING 1
        `.execute(trx);
        const stones = await sql<{ tenant_id: string }>`
          SELECT tenant_id::text AS tenant_id FROM zv_sync_tombstones WHERE row_id = ${theirs}::uuid
        `.execute(trx);
        throw Object.assign(new Error('rollback'), {
          seen: { deleted: del.rows.length, stones: stones.rows },
        });
      })
      .catch((err: { seen?: unknown }) => {
        if (!err.seen) throw err;
        return err.seen;
      });
    expect(seen).toEqual({ deleted: 1, stones: [{ tenant_id: OTHER_TENANT }] });
  });

  it('a position older than the retention answers resync and restarts the collection', async () => {
    const keep = await insert(db, 'kept');
    const stale = `${(Date.now() - 40 * 86_400_000) * 1000}:00000000-0000-0000-0000-000000000000`;
    const body = await pull({ cursors: { [TABLE]: stale } });
    expect(body.resync?.[TABLE]).toBe(true);
    expect(body.changes.map((ch) => ch.id)).toContain(keep);
    expect(deletesIn(body)).toEqual([]);

    const bySince = await pull({ since: Date.now() - 40 * 86_400_000 });
    expect(bySince.resync?.[TABLE]).toBe(true);

    const fresh = await pull({ cursors: body.cursors });
    expect(fresh.resync?.[TABLE]).toBeUndefined();
  });

  it('the nightly collector purges tombstones past the retention', async () => {
    const [oldId, newId] = [crypto.randomUUID(), crypto.randomUUID()];
    await sql`
      INSERT INTO zv_sync_tombstones (tenant_id, collection, row_id, deleted_at) VALUES
        ('00000000-0000-0000-0000-000000000001', ${TABLE}, ${oldId}::uuid, now() - interval '40 days'),
        (${OTHER_TENANT}::uuid, ${TABLE}, ${newId}::uuid, now())
    `.execute(db);
    await runGarbageCollector(db);
    const { rows } = await sql<{ row_id: string }>`
      SELECT row_id::text AS row_id FROM zv_sync_tombstones
      WHERE row_id IN (${oldId}::uuid, ${newId}::uuid)
    `.execute(db);
    expect(rows).toEqual([{ row_id: newId }]);
  });
});
