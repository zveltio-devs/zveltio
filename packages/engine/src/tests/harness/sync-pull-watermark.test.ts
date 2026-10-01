/**
 * Sync pull never moves a client past a row that is still being written.
 *
 * A row's `updated_at` is its transaction's `now()` — the moment the
 * transaction STARTED, not the moment it commits. A pull that ran while that
 * transaction was open could not see the row, yet handed back a cursor already
 * past it: a committed row written later. Once the transaction committed, its
 * row sat behind the client's position and was never pulled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { syncWatermarkUs } from '../../routes/sync.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `hsyncwm_${Date.now()}`;

type PullBody = {
  changes: Array<{ id: string; data: { title?: string } }>;
  cursors?: Record<string, string>;
};

d('sync pull holds its position behind in-flight transactions', () => {
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
  const titles = (b: PullBody) => b.changes.map((ch) => ch.data.title);
  const insert = (on: Database, title: string) =>
    sql`INSERT INTO ${sql.table(`zvd_${NAME}`)} (title) VALUES (${title})`.execute(on);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: NAME,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${NAME}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', NAME).execute();
  });

  it('a row committed after the pull still arrives', async () => {
    const collections = [`zvd_${NAME}`];
    await insert(db, 'before');

    let first: PullBody | null = null;
    await db.transaction().execute(async (trx) => {
      // `updated_at` = this transaction's start.
      await insert(trx, 'in-flight');
      await Bun.sleep(5);
      // Committed, and newer than the in-flight row.
      await insert(db, 'after');
      first = await pull({ collections });
    });
    const f = first as unknown as PullBody;
    expect(titles(f)).toContain('before');
    expect(titles(f)).not.toContain('in-flight');

    const byCursor = await pull({ collections, cursors: f.cursors });
    expect(titles(byCursor)).toContain('in-flight');
  });

  it('a client cannot back-date updated_at through a push', async () => {
    const res = await app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        operations: [
          {
            collection: NAME,
            recordId: crypto.randomUUID(),
            operation: 'create',
            payload: { title: 'backdated', updated_at: '2000-01-01T00:00:00Z' },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const { rows } = await sql<{ old: boolean }>`
      SELECT updated_at < now() - interval '1 day' AS old
      FROM ${sql.table(`zvd_${NAME}`)} WHERE title = 'backdated'`.execute(db);
    expect(rows).toEqual([{ old: false }]);
  });

  // The engine role may not be allowed to read another session's `xact_start`
  // (a plain role without pg_read_all_stats). Such a session inside a
  // transaction could be writing rows of any age: the watermark refuses to move.
  it('a transaction the watermark cannot inspect holds it at zero', async () => {
    await db.transaction().execute(async (open) => {
      await sql`SELECT 1`.execute(open);
      const w = await db.transaction().execute(async (blind) => {
        await sql`SELECT set_config('role', 'zveltio_rls', true)`.execute(blind);
        return syncWatermarkUs(blind, 0);
      });
      expect(w).toBe('0');
    });
  });
});
