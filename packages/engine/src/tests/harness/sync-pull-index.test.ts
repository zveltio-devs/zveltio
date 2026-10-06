/**
 * An idle sync pull walks the keyset index, not every row the tenant has.
 *
 * The pull's position is `(updated_at, id)`, compared as a row of an EXPRESSION
 * (`extract(epoch …)::bigint`), under a policy that reads `tenant_id = ANY (…)`,
 * on tables with no index on `updated_at`. Nothing in that shape can bound a
 * scan, so a pull where NOTHING changed read the whole collection — per pull,
 * per collection, per device. Measured on a tenant with 200 000 rows: 63 ms
 * and 2 535 buffers, against 0,08 ms and 3 once `tenant_id =` and
 * `updated_at >=` sit beside the row comparison and the table has
 * `(tenant_id, updated_at, id::text COLLATE "C")`.
 *
 * Judged on the real code path through the statistics collector: the pull is
 * made through the route, and `pg_stat_user_indexes` then says whether it read
 * the index and how many rows it touched. A plan read off a copy of the SQL
 * would prove the copy.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `hsyncidx_${Date.now()}`;
const TABLE = `zvd_${NAME}`;
const INDEX = `idx_${TABLE}_tenant_updated`;
// Enough that a planner given the index prefers it over reading the table.
const ROWS = 5000;

type PullBody = {
  changes: Array<{ id: string; data: { title?: string } }>;
  hasMore?: boolean;
  cursors?: Record<string, string>;
};

type TableStats = { seq_tup_read: string; idx_tup_fetch: string };
type IndexStats = { idx_scan: string; idx_tup_read: string } | undefined;

d('sync pull uses the (tenant_id, updated_at, id) index', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const pull = async (body: Record<string, unknown>): Promise<PullBody> => {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as PullBody;
  };

  const tableStats = async (): Promise<TableStats> =>
    (
      await sql<TableStats>`
        SELECT seq_tup_read::text, idx_tup_fetch::text
          FROM pg_stat_user_tables WHERE relname = ${TABLE}
      `.execute(db)
    ).rows[0]!;
  const indexStats = async (): Promise<IndexStats> =>
    (
      await sql<NonNullable<IndexStats>>`
        SELECT idx_scan::text, idx_tup_read::text
          FROM pg_stat_user_indexes WHERE indexrelname = ${INDEX}
      `.execute(db)
    ).rows[0];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    // Through the route: the DDL queue's create_collection job, which is what
    // gives a table its tenant indexes (`applyTenantRLS`), not DDLManager alone.
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: NAME,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      }),
    });
    expect([200, 201, 202]).toContain(res.status);
    // Rows spread over the past month, all older than any cursor below. A pair
    // ties on `updated_at` so the keyset's second column is exercised.
    await sql
      .raw(
        `INSERT INTO "${TABLE}" (title, updated_at)
         SELECT 'r' || g, now() - interval '30 days' + (g / 2) * interval '10 seconds'
         FROM generate_series(1, ${ROWS}) g`,
      )
      .execute(db);
    await sql.raw(`ANALYZE "${TABLE}"`).execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', NAME)
      .execute()
      .catch(() => {});
  });

  it('a collection created through the API carries the keyset index', async () => {
    const r = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${INDEX}
    `.execute(db);
    expect(r.rows[0]?.indexdef ?? '').toContain(
      `ON public.${TABLE} USING btree (tenant_id, updated_at, ((id)::text) COLLATE "C")`,
    );
  });

  it('an idle incremental pull reads the index and none of the rows', async () => {
    // A client that is caught up: its position is a minute ago, its deletes
    // complete from the same moment — well inside the tombstone retention.
    const us = `${(Date.now() - 60_000) * 1000}`;
    const cursor = `d${us}:${us}:00000000-0000-0000-0000-000000000000`;
    const before = { table: await tableStats(), index: await indexStats() };
    expect(before.index).toBeDefined();

    const body = await pull({ collections: [TABLE], cursors: { [TABLE]: cursor } });
    expect(body.changes).toEqual([]);
    expect(body.hasMore).toBe(false);

    // The pull's backend flushes its counters when it goes idle, within about a
    // second; wait for the scan to be reported rather than read a stale count.
    let after = { table: await tableStats(), index: await indexStats() };
    const deadline = Date.now() + 15_000;
    while (
      Date.now() < deadline &&
      BigInt(after.index?.idx_scan ?? '0') <= BigInt(before.index?.idx_scan ?? '0')
    ) {
      await Bun.sleep(200);
      after = { table: await tableStats(), index: await indexStats() };
    }
    expect(BigInt(after.index!.idx_scan)).toBeGreaterThan(BigInt(before.index!.idx_scan));
    // Index entries returned and table rows fetched by the pull: a bounded scan
    // past the newest row touches none, where the old shape read all 5 000.
    const read =
      BigInt(after.index!.idx_tup_read) -
      BigInt(before.index!.idx_tup_read) +
      BigInt(after.table.seq_tup_read) -
      BigInt(before.table.seq_tup_read) +
      BigInt(after.table.idx_tup_fetch) -
      BigInt(before.table.idx_tup_fetch);
    expect(read).toBeLessThan(10n);
  }, 30_000);

  it('a client behind the newest rows still gets exactly them, in keyset order', async () => {
    // The position of the 4 000th row in keyset order; the client owes the rest.
    const order = await sql<{ id: string; us: string }>`
      SELECT id::text AS id, (extract(epoch FROM updated_at) * 1000000)::bigint::text AS us
        FROM ${sql.table(TABLE)} ORDER BY updated_at, id::text COLLATE "C"
    `.execute(db);
    const at = order.rows[3999]!;
    const del = `${(Date.now() - 60_000) * 1000}`;
    const body = await pull({
      collections: [TABLE],
      cursors: { [TABLE]: `d${del}:${at.us}:${at.id}` },
    });
    expect(body.hasMore).toBe(false);
    expect(body.changes.map((ch) => ch.id)).toEqual(order.rows.slice(4000).map((r) => r.id));
    const last = order.rows.at(-1)!;
    expect(body.cursors?.[TABLE]).toMatch(new RegExp(`^d\\d+:${last.us}:${last.id}$`));
  });
});
